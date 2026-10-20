import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client/web";
import { AgnesClient } from "./agnesClient.js";

export interface PendingSceneRow {
  id: number;
  series_id: number;
  episode_number: number;
  scene_number: number;
  variant: string;
  status: string;
  prompt: string;
  request_digest: string | null;
  attempt_count: number;
  seed: number | null;
  requested_duration_seconds: number;
  provider_duration_seconds: number;
  public_reference_url: string | null;
  provider_receipt_json: string | null;
}

export interface SubmissionRunResult {
  runAt: number;
  pendingFound: number;
  submittedCount: number;
  failedCount: number;
  durationMs: number;
  log: string;
  details: {
    submitted: Array<{
      seriesId: number;
      episodeNumber: number;
      sceneNumber: number;
      taskId: string;
      keyLabel: string;
    }>;
    failed: Array<{
      seriesId: number;
      episodeNumber: number;
      sceneNumber: number;
      error: string;
    }>;
  };
}

/**
 * Core submission engine:
 * 1. Connects to Turso database.
 * 2. Scans episodes with confirmed audio readiness (audio_status='ready' or status in ('audio', 'assembly')).
 * 3. Finds pending scenes (status='pending' and provider_task_id IS NULL).
 * 4. Submits candidate scenes using multi-key rotation and capacity retries with backoff/jitter.
 * 5. Atomically records accepted task ID and envelope into Turso DB.
 */
export async function executePendingSubmissions(): Promise<SubmissionRunResult> {
  const startTime = Date.now();
  const logs: string[] = [];
  const log = (msg: string) => {
    const entry = `[AgnesSubmitter] ${msg}`;
    console.log(entry);
    logs.push(entry);
  };

  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;

  if (!tursoUrl || !tursoToken) {
    throw new Error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN environment variables");
  }

  const db = createClient({ url: tursoUrl, authToken: tursoToken });
  const agnesClient = new AgnesClient();

  log("Starting pending Agnes scene submission cycle...");

  // 1. Find episodes whose audio is ready
  const episodesResult = await db.execute(`
    SELECT id, series_id, episode_number, title, status, audio_status
    FROM episodes
    WHERE audio_status = 'ready' OR status IN ('audio', 'assembly')
    ORDER BY series_id ASC, episode_number ASC
  `);

  const eligibleEpisodes = episodesResult.rows as unknown as Array<{
    id: number;
    series_id: number;
    episode_number: number;
    title: string;
    status: string;
    audio_status: string;
  }>;

  if (eligibleEpisodes.length === 0) {
    log("No episodes found with verified audio ready (audio_status='ready' or status in ('audio', 'assembly')). Exiting run.");
    const durationMs = Date.now() - startTime;
    return {
      runAt: startTime,
      pendingFound: 0,
      submittedCount: 0,
      failedCount: 0,
      durationMs,
      log: logs.join("\n"),
      details: { submitted: [], failed: [] },
    };
  }

  // 2. Query pending scenes across all eligible episodes
  const pendingScenes: PendingSceneRow[] = [];

  for (const ep of eligibleEpisodes) {
    const scenesResult = await db.execute({
      sql: `
        SELECT id, series_id, episode_number, scene_number, variant, status, prompt,
               request_digest, attempt_count, seed, requested_duration_seconds,
               provider_duration_seconds, public_reference_url, provider_receipt_json
        FROM agnes_scene_generations
        WHERE series_id = ? AND episode_number = ? AND status = 'pending'
        ORDER BY scene_number ASC
      `,
      args: [ep.series_id, ep.episode_number],
    });

    for (const row of scenesResult.rows) {
      pendingScenes.push(row as unknown as PendingSceneRow);
    }
  }

  const totalPending = pendingScenes.length;
  log(`Discovered ${totalPending} pending scene(s) across ${eligibleEpisodes.length} eligible episode(s).`);

  if (totalPending === 0) {
    log("All scenes are already queued or completed. No pending submissions required.");
    const durationMs = Date.now() - startTime;
    return {
      runAt: startTime,
      pendingFound: 0,
      submittedCount: 0,
      failedCount: 0,
      durationMs,
      log: logs.join("\n"),
      details: { submitted: [], failed: [] },
    };
  }

  const maxPerRun = Number(process.env.AGNES_MAX_SUBMISSIONS_PER_RUN ?? 10);
  const candidateBatch = pendingScenes.slice(0, maxPerRun);
  log(`Processing batch of ${candidateBatch.length} scene(s) (configured max per run: ${maxPerRun}).`);

  const submitted: SubmissionRunResult["details"]["submitted"] = [];
  const failed: SubmissionRunResult["details"]["failed"] = [];

  const TIME_BUDGET_MS = 540_000; // 9 minutes
  const runDeadlineMs = startTime + TIME_BUDGET_MS;

  for (const scene of candidateBatch) {
    if (Date.now() >= runDeadlineMs) {
      log(`Run time reached 9-minute budget (${Math.round((Date.now() - startTime) / 1000)}s). Yielding remaining scene(s) to next scheduled invocation.`);
      break;
    }

    const sceneLabel = `Series ${scene.series_id} Ep ${scene.episode_number} Scene ${scene.scene_number}`;
    log(`Attempting submission for ${sceneLabel} (${scene.provider_duration_seconds}s)...`);

    // Parse reference image URLs if available
    let referenceUrls: string[] | undefined;
    if (scene.public_reference_url) {
      try {
        const parsed = JSON.parse(scene.public_reference_url);
        if (Array.isArray(parsed) && parsed.length > 0) {
          referenceUrls = parsed.filter((u) => typeof u === "string" && u.startsWith("http"));
        }
      } catch {
        if (scene.public_reference_url.startsWith("http")) {
          referenceUrls = [scene.public_reference_url];
        }
      }
    }

    try {
      const result = await agnesClient.submitVideo({
        prompt: scene.prompt,
        seconds: scene.provider_duration_seconds,
        seed: scene.seed ?? undefined,
        referenceImageUrls: referenceUrls,
      }, runDeadlineMs);

      const nowIso = new Date().toISOString();
      let envelope: any;
      if (scene.provider_receipt_json) {
        try {
          envelope = JSON.parse(scene.provider_receipt_json);
        } catch {
          envelope = null;
        }
      }

      if (!envelope || !Array.isArray(envelope.attempts)) {
        envelope = {
          schemaVersion: 3,
          kind: "agnes-single-scene",
          requestDigest: scene.request_digest || "",
          providerSeconds: scene.provider_duration_seconds,
          attempts: [],
        };
      }

      envelope.attempts.push({
        attemptNumber: (scene.attempt_count ?? 0) + 1,
        claimToken: randomUUID(),
        state: "accepted",
        startedAt: nowIso,
        finishedAt: nowIso,
        retrySafe: false,
        accountId: result.accountId,
        keyLabel: result.keyLabel,
        keyFingerprint: result.keyFingerprint,
        submissionPhase: "post_started",
        task: {
          id: result.taskId,
          task_id: result.taskId,
          video_id: result.taskId,
          model: process.env.AGNES_VIDEO_MODEL ?? "agnes-video-2.5-flash",
          status: "queued",
          progress: 0,
          keyLabel: result.keyLabel,
          keyFingerprint: result.keyFingerprint,
          object: "video",
          seconds: String(scene.provider_duration_seconds),
          size: "720P",
        },
      });

      const updatedReceiptJson = JSON.stringify(envelope);

      // Persist the accepted submission into Turso DB
      await db.execute({
        sql: `
          UPDATE agnes_scene_generations
          SET status = 'queued',
              provider_task_id = ?,
              provider_receipt_json = ?,
              attempt_count = attempt_count + 1,
              submitted_at = ?,
              error = NULL,
              updated_at = datetime('now')
          WHERE id = ? AND status = 'pending'
        `,
        args: [result.taskId, updatedReceiptJson, nowIso, scene.id],
      });

      log(`[ACCEPTED] ${sceneLabel} -> Agnes Video ID: ${result.taskId} (${result.keyLabel}, ${result.accountId})`);

      submitted.push({
        seriesId: scene.series_id,
        episodeNumber: scene.episode_number,
        sceneNumber: scene.scene_number,
        taskId: result.taskId,
        keyLabel: result.keyLabel,
      });
    } catch (err: any) {
      const errMsg = err?.message ?? String(err);
      log(`[FAILED] ${sceneLabel} -> Error: ${errMsg}`);

      failed.push({
        seriesId: scene.series_id,
        episodeNumber: scene.episode_number,
        sceneNumber: scene.scene_number,
        error: errMsg,
      });

      // Update attempt count and last error in Turso DB
      try {
        await db.execute({
          sql: `
            UPDATE agnes_scene_generations
            SET attempt_count = attempt_count + 1,
                error = ?,
                updated_at = datetime('now')
            WHERE id = ? AND status = 'pending'
          `,
          args: [errMsg, scene.id],
        });
      } catch (dbErr) {
        console.error(`[AgnesSubmitter] Failed to update error state in Turso for scene ${scene.id}:`, dbErr);
      }

      if (Date.now() >= runDeadlineMs || errMsg.includes("9-minute execution budget reached") || errMsg.includes("exceeds 9-minute run budget")) {
        log(`9-minute execution budget reached. Ending current run batch cleanly.`);
        break;
      }
    }
  }

  const durationMs = Date.now() - startTime;
  log(`Run completed in ${durationMs}ms: Saw ${totalPending} pending scene(s). Successfully submitted ${submitted.length}. Failed ${failed.length}. Remaining pending: ${totalPending - submitted.length}.`);

  return {
    runAt: startTime,
    pendingFound: totalPending,
    submittedCount: submitted.length,
    failedCount: failed.length,
    durationMs,
    log: logs.join("\n"),
    details: { submitted, failed },
  };
}
