import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Convex database schema for file storage segregation and Agnes submission logging.
 */
export default defineSchema({
  storedFiles: defineTable({
    storageId: v.id("_storage"),
    path: v.string(), // Virtual directory path
    bucket: v.string(), // Bucket / namespace
    fileName: v.string(),
    contentType: v.string(),
    size: v.number(),
    sha256: v.optional(v.string()),
    url: v.optional(v.string()),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_bucket_and_path", ["bucket", "path"])
    .index("by_bucket", ["bucket"])
    .index("by_path", ["path"])
    .index("by_storageId", ["storageId"]),

  agnesSubmissionRuns: defineTable({
    runAt: v.number(),
    pendingFound: v.number(),
    submittedCount: v.number(),
    failedCount: v.number(),
    durationMs: v.number(),
    log: v.string(),
    results: v.optional(v.any()),
  })
    .index("by_runAt", ["runAt"]),
});
