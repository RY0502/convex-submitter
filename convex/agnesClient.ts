"use node";

import { createHash } from "node:crypto";

export interface ConfiguredKey {
  key: string;
  keyLabel: string;
  keyFingerprint: string;
}

export function fingerprintAgnesKey(key: string): string {
  return createHash("sha256").update(key.trim()).digest("hex");
}

export function loadAgnesApiKeys(env: Record<string, string | undefined> = process.env): ConfiguredKey[] {
  const result: ConfiguredKey[] = [];
  const seen = new Set<string>();

  for (let i = 1; i <= 20; i++) {
    const val = env[`AGNES_API_KEY_${i}`]?.trim();
    if (val && !seen.has(val)) {
      seen.add(val);
      result.push({
        key: val,
        keyLabel: `key-${result.length + 1}`,
        keyFingerprint: fingerprintAgnesKey(val),
      });
    }
  }

  const defaultKey = env.AGNES_API_KEY?.trim();
  if (defaultKey && !seen.has(defaultKey)) {
    seen.add(defaultKey);
    result.push({
      key: defaultKey,
      keyLabel: `key-${result.length + 1}`,
      keyFingerprint: fingerprintAgnesKey(defaultKey),
    });
  }

  return result;
}

const CAPACITY_CODES = new Set([
  "video_queue_full",
  "queue_full",
  "submission_queue_full",
  "video_submission_queue_full",
  "capacity_exceeded",
  "queue_capacity_exceeded",
  "queue_capacity_reached",
  "queue_at_capacity",
  "server_busy",
  "system_busy",
]);

export function isCapacityRejection(status: number, payload: unknown): boolean {
  if (status === 503) return true;
  if (!payload || typeof payload !== "object") return false;

  const rec = payload as Record<string, unknown>;
  const code = String(rec.code ?? (rec.error as any)?.code ?? "").toLowerCase();
  if (code && CAPACITY_CODES.has(code)) return true;

  const text = JSON.stringify(payload).toLowerCase();
  if (text.includes("queue is full") || text.includes("queue full") || text.includes("video queue")) {
    return true;
  }
  if (text.includes("at capacity") || text.includes("capacity exceeded") || text.includes("server busy") || text.includes("system busy")) {
    return true;
  }
  return false;
}

export function isRateLimited(status: number, payload: unknown): boolean {
  if (status === 429) return true;
  const text = JSON.stringify(payload ?? "").toLowerCase();
  return text.includes("rate limit") || text.includes("ratelimit") || text.includes("rate_limit_exceeded") || text.includes("too many requests");
}

export function isQuotaExhausted(status: number, payload: unknown): boolean {
  if (status === 401 || status === 403) return true;
  const text = JSON.stringify(payload ?? "").toLowerCase();
  return text.includes("insufficient") || text.includes("out of credits") || text.includes("daily limit");
}

export interface AgnesSubmitRequest {
  prompt: string;
  seconds: number;
  mode?: "text" | "reference";
  aspectRatio?: string;
  seed?: number;
  referenceImageUrls?: string[];
}

export interface AgnesSubmitSuccess {
  taskId: string;
  status: string;
  keyLabel: string;
  keyFingerprint: string;
  accountId: string;
  rawPayload: unknown;
}

export interface AgnesClientOptions {
  baseUrl?: string;
  keys?: ConfiguredKey[];
  capacityMaxRetries?: number;
  capacityRetryIntervalMs?: number;
  capacityRetryJitterMs?: number;
  requestTimeoutMs?: number;
}

export class AgnesClient {
  readonly baseUrl: string;
  readonly keys: ConfiguredKey[];
  readonly capacityMaxRetries: number;
  readonly capacityRetryIntervalMs: number;
  readonly capacityRetryJitterMs: number;
  readonly requestTimeoutMs: number;
  private lastRequestTimeMs = 0;

  constructor(options: AgnesClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com").replace(/\/+$/, "");
    this.keys = options.keys && options.keys.length > 0 ? options.keys : loadAgnesApiKeys();
    this.capacityMaxRetries = options.capacityMaxRetries ?? Number(process.env.AGNES_CAPACITY_MAX_RETRIES ?? 30);
    this.capacityRetryIntervalMs = options.capacityRetryIntervalMs ?? Number(process.env.AGNES_CAPACITY_RETRY_INTERVAL_MS ?? 5000);
    this.capacityRetryJitterMs = options.capacityRetryJitterMs ?? Number(process.env.AGNES_CAPACITY_RETRY_JITTER_MS ?? 3000);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60000;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async submitVideo(request: AgnesSubmitRequest, deadlineMs?: number): Promise<AgnesSubmitSuccess> {
    if (this.keys.length === 0) {
      throw new Error("No Agnes API keys configured. Set AGNES_API_KEY_1 (or AGNES_API_KEY)");
    }

    const mode = request.referenceImageUrls && request.referenceImageUrls.length > 0
      ? "reference"
      : (request.mode ?? "text");

    const payload: Record<string, unknown> = {
      model: process.env.AGNES_VIDEO_MODEL ?? "agnes-video-2.5-flash",
      prompt: request.prompt,
      seconds: String(request.seconds),
      mode,
      size: "720P",
      aspect_ratio: request.aspectRatio ?? "16:9",
      n: 1,
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.referenceImageUrls && request.referenceImageUrls.length > 0 ? { images: request.referenceImageUrls } : {}),
    };

    const body = JSON.stringify(payload);

    interface ActiveKeyState {
      configuredKey: ConfiguredKey;
      accountId: string;
      retryCount: number;
      nextEligibleAtMs: number;
    }

    const activeKeys: ActiveKeyState[] = this.keys.map((configuredKey, idx) => ({
      configuredKey,
      accountId: `account-${idx + 1}`,
      retryCount: 0,
      nextEligibleAtMs: 0,
    }));

    let lastError: Error | undefined;
    let lastAttemptedIndex = -1;

    while (activeKeys.length > 0) {
      if (deadlineMs && Date.now() >= deadlineMs) {
        throw new Error(`9-minute execution budget reached. Yielding to next scheduled invocation.`);
      }
      let chosenIndex = -1;
      const now = Date.now();

      for (let offset = 1; offset <= activeKeys.length; offset++) {
        const candidateIndex = (lastAttemptedIndex + offset) % activeKeys.length;
        const candidate = activeKeys[candidateIndex];
        if (candidate && now >= candidate.nextEligibleAtMs) {
          chosenIndex = candidateIndex;
          break;
        }
      }

      if (chosenIndex === -1) {
        let earliestIndex = 0;
        for (let i = 1; i < activeKeys.length; i++) {
          if (activeKeys[i].nextEligibleAtMs < activeKeys[earliestIndex].nextEligibleAtMs) {
            earliestIndex = i;
          }
        }
        const earliestKey = activeKeys[earliestIndex];
        const waitMs = Math.max(0, earliestKey.nextEligibleAtMs - Date.now());
        if (deadlineMs && Date.now() + waitMs >= deadlineMs) {
          throw new Error(`All keys in cooldown and wait (${Math.round(waitMs / 1000)}s) exceeds 9-minute run budget. Yielding to next scheduled invocation.`);
        }
        if (waitMs > 0) {
          console.log(`[AgnesClient] All keys in cooldown. Waiting ${waitMs}ms for ${earliestKey.configuredKey.keyLabel} (attempt ${earliestKey.retryCount + 1}/${this.capacityMaxRetries})`);
          await this.sleep(waitMs);
        }
        chosenIndex = earliestIndex;
      }

      const keyEntry = activeKeys[chosenIndex];
      lastAttemptedIndex = chosenIndex;
      const { configuredKey, accountId } = keyEntry;

      // Pacing: ensure at least 1500ms between consecutive API calls to avoid rate limiting
      const elapsedSinceLast = Date.now() - this.lastRequestTimeMs;
      if (elapsedSinceLast < 1500) {
        await this.sleep(1500 - elapsedSinceLast);
      }
      this.lastRequestTimeMs = Date.now();

      const endpoint = `${this.baseUrl}/v1/videos`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

      let response: Response;
      let resultText = "";
      let jsonPayload: any = null;

      try {
        console.log(`[AgnesClient] Submitting scene (${request.seconds}s, mode=${mode}) using ${configuredKey.keyLabel} (${accountId})...`);
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": `Bearer ${configuredKey.key}`,
          },
          body,
          signal: controller.signal,
        });

        resultText = await response.text();
        try {
          jsonPayload = JSON.parse(resultText);
        } catch {
          jsonPayload = null;
        }
      } catch (err: any) {
        lastError = err;
        console.warn(`[AgnesClient] Network/fetch error with ${configuredKey.keyLabel}: ${err.message}`);
        keyEntry.nextEligibleAtMs = Date.now() + 5000;
        continue;
      } finally {
        clearTimeout(timer);
      }

      // 1. Success case: HTTP 200 with task ID
      if (response.ok && jsonPayload) {
        const taskId = jsonPayload.task_id || jsonPayload.id || jsonPayload.video_id;
        if (taskId) {
          console.log(`[AgnesClient] Success! Task submitted: ${taskId} (${configuredKey.keyLabel})`);
          return {
            taskId: String(taskId),
            status: jsonPayload.status ?? "queued",
            keyLabel: configuredKey.keyLabel,
            keyFingerprint: configuredKey.keyFingerprint,
            accountId,
            rawPayload: jsonPayload,
          };
        }
      }

      // 2. Capacity rejection (queue full, 503, etc.)
      if (isCapacityRejection(response.status, jsonPayload ?? resultText)) {
        keyEntry.retryCount += 1;
        const jitter = Math.floor(Math.random() * this.capacityRetryJitterMs);
        const retryDelay = this.capacityRetryIntervalMs + jitter;
        const errMsg = jsonPayload?.message || jsonPayload?.error?.message || resultText || "Queue full";
        lastError = new Error(`Agnes capacity rejection: ${errMsg}`);

        console.warn(`[AgnesClient] ${configuredKey.keyLabel} encountered capacity rejection (${response.status}): ${errMsg}. Backing off for ${retryDelay}ms (attempt ${keyEntry.retryCount}/${this.capacityMaxRetries}).`);

        if (keyEntry.retryCount >= this.capacityMaxRetries) {
          console.warn(`[AgnesClient] ${configuredKey.keyLabel} reached max retries (${this.capacityMaxRetries}). Removing from active pool.`);
          activeKeys.splice(chosenIndex, 1);
          lastAttemptedIndex -= 1;
        } else {
          keyEntry.nextEligibleAtMs = Date.now() + retryDelay;
        }
        continue;
      }

      // 3. Rate limited (HTTP 429)
      if (isRateLimited(response.status, jsonPayload ?? resultText)) {
        const errMsg = jsonPayload?.error?.message || jsonPayload?.message || "Rate limit reached";
        console.warn(`[AgnesClient] ${configuredKey.keyLabel} rate limited (${response.status}): ${errMsg}. Setting key cooldown for 60s.`);
        keyEntry.nextEligibleAtMs = Date.now() + 60000;
        lastError = new Error(`Rate limit on ${configuredKey.keyLabel}: ${errMsg}`);
        continue;
      }

      // 4. Quota exhausted or authentication failure
      if (isQuotaExhausted(response.status, jsonPayload ?? resultText)) {
        console.warn(`[AgnesClient] ${configuredKey.keyLabel} quota/credits exhausted or invalid (${response.status}). Dropping key.`);
        activeKeys.splice(chosenIndex, 1);
        lastAttemptedIndex -= 1;
        lastError = new Error(`Key ${configuredKey.keyLabel} quota exhausted or unauthorized`);
        continue;
      }

      // 5. Other error (validation, unexpected error)
      const errDetail = jsonPayload ? JSON.stringify(jsonPayload) : resultText;
      console.error(`[AgnesClient] Agnes rejected request with HTTP ${response.status}: ${errDetail}`);
      lastError = new Error(`Agnes HTTP ${response.status}: ${errDetail}`);

      if (response.status === 400 || response.status === 422) {
        throw lastError;
      }

      keyEntry.nextEligibleAtMs = Date.now() + 5000;
    }

    throw lastError ?? new Error("All Agnes API keys exhausted or capacity limits reached.");
  }
}
