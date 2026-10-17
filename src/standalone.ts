import dotenv from "dotenv";
dotenv.config();

import { executePendingSubmissions } from "./engine.js";

async function main() {
  console.log("=== Agnes Scene Submitter (Standalone Runner) ===");
  try {
    const result = await executePendingSubmissions();
    console.log("\n=== Execution Summary ===");
    console.log(`Run Time: ${new Date(result.runAt).toISOString()}`);
    console.log(`Pending Scenes Found: ${result.pendingFound}`);
    console.log(`Successfully Submitted: ${result.submittedCount}`);
    console.log(`Failed: ${result.failedCount}`);
    console.log(`Duration: ${result.durationMs}ms`);
    if (result.details.submitted.length > 0) {
      console.log("\nSubmitted Details:");
      for (const item of result.details.submitted) {
        console.log(`  - Series ${item.seriesId} Ep ${item.episodeNumber} Scene ${item.sceneNumber} -> Task ID: ${item.taskId} (${item.keyLabel})`);
      }
    }
  } catch (err: any) {
    console.error("Submission run failed with error:", err);
    process.exit(1);
  }
}

main();
