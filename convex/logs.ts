import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Mutation to record execution logs in Convex database.
 */
export const recordRunLog = internalMutation({
  args: {
    runAt: v.number(),
    pendingFound: v.number(),
    submittedCount: v.number(),
    failedCount: v.number(),
    durationMs: v.number(),
    log: v.string(),
    results: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("agnesSubmissionRuns", args);
  },
});

export const getRecentRuns = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;
    return await ctx.db
      .query("agnesSubmissionRuns")
      .withIndex("by_runAt")
      .order("desc")
      .take(limit);
  },
});
