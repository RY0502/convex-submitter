import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

function toCdnUrl(url: string | null): string | null {
  if (!url) return null;
  const cdn = (process.env.CONVEX_CDN_URL || "https://convex-portrait-cache.ravi-y0102.workers.dev").replace(/\/+$/gu, "");
  return url.replace(/^https?:\/\/[^/]+/u, cdn);
}

/**
 * Mutation: Generates a short-lived Convex upload URL for uploading raw file bytes.
 */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Mutation: Saves file metadata in the `storedFiles` table, generates a public
 * serve URL, and deletes any previously stored file for the same (bucket, path)
 * to avoid orphaned storage objects.
 */
export const saveFile = mutation({
  args: {
    storageId: v.id("_storage"),
    bucket: v.string(),
    path: v.string(),
    fileName: v.string(),
    contentType: v.string(),
    size: v.number(),
    sha256: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("storedFiles")
      .withIndex("by_bucket_and_path", (q) =>
        q.eq("bucket", args.bucket).eq("path", args.path),
      )
      .first();

    // If an existing file exists with a different storageId, clean up old storage object
    if (existing && existing.storageId !== args.storageId) {
      try {
        await ctx.storage.delete(existing.storageId);
      } catch (err) {
        console.warn(`[ConvexFiles] Could not delete old storage object ${existing.storageId}:`, err);
      }
    }

    const rawUrl = await ctx.storage.getUrl(args.storageId);
    const publicUrl = toCdnUrl(rawUrl);
    const now = Date.now();


    if (existing) {
      await ctx.db.patch(existing._id, {
        storageId: args.storageId,
        fileName: args.fileName,
        contentType: args.contentType,
        size: args.size,
        sha256: args.sha256,
        url: publicUrl ?? undefined,
        metadata: args.metadata,
        updatedAt: now,
      });

      return {
        _id: existing._id,
        storageId: args.storageId,
        bucket: args.bucket,
        path: args.path,
        fileName: args.fileName,
        contentType: args.contentType,
        size: args.size,
        sha256: args.sha256,
        url: publicUrl,
        metadata: args.metadata,
        createdAt: existing.createdAt,
        updatedAt: now,
      };
    }

    const insertedId = await ctx.db.insert("storedFiles", {
      storageId: args.storageId,
      bucket: args.bucket,
      path: args.path,
      fileName: args.fileName,
      contentType: args.contentType,
      size: args.size,
      sha256: args.sha256,
      url: publicUrl ?? undefined,
      metadata: args.metadata,
      createdAt: now,
      updatedAt: now,
    });

    return {
      _id: insertedId,
      storageId: args.storageId,
      bucket: args.bucket,
      path: args.path,
      fileName: args.fileName,
      contentType: args.contentType,
      size: args.size,
      sha256: args.sha256,
      url: publicUrl,
      metadata: args.metadata,
      createdAt: now,
      updatedAt: now,
    };
  },
});

/**
 * Query: Looks up a stored file by bucket and virtual path, generating a fresh public URL.
 */
export const getFile = query({
  args: {
    bucket: v.string(),
    path: v.string(),
  },
  handler: async (ctx, args) => {
    const file = await ctx.db
      .query("storedFiles")
      .withIndex("by_bucket_and_path", (q) =>
        q.eq("bucket", args.bucket).eq("path", args.path),
      )
      .first();

    if (!file) return null;

    const freshUrl = toCdnUrl(await ctx.storage.getUrl(file.storageId));
    return {
      ...file,
      url: freshUrl ?? toCdnUrl(file.url ?? null) ?? file.url,
    };
  },
});

/**
 * Query: Lists stored files in a bucket, optionally filtering by path prefix.
 */
export const listFiles = query({
  args: {
    bucket: v.string(),
    prefix: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("storedFiles")
      .withIndex("by_bucket", (q) => q.eq("bucket", args.bucket))
      .collect();

    const prefix = args.prefix ?? "";
    const matched = prefix
      ? files.filter((f) => f.path.startsWith(prefix))
      : files;

    return await Promise.all(
      matched.map(async (file) => ({
        ...file,
        url: toCdnUrl(await ctx.storage.getUrl(file.storageId)) ?? toCdnUrl(file.url ?? null) ?? file.url,
      })),
    );
  },
});

/**
 * Mutation: Deletes a stored file by bucket and path, removing both storage object and DB record.
 */
export const deleteFile = mutation({
  args: {
    bucket: v.string(),
    path: v.string(),
  },
  handler: async (ctx, args) => {
    const file = await ctx.db
      .query("storedFiles")
      .withIndex("by_bucket_and_path", (q) =>
        q.eq("bucket", args.bucket).eq("path", args.path),
      )
      .first();

    if (!file) return { deleted: false };

    try {
      await ctx.storage.delete(file.storageId);
    } catch (err) {
      console.warn(`[ConvexFiles] Could not delete storage object ${file.storageId}:`, err);
    }

    await ctx.db.delete(file._id);
    return { deleted: true, path: args.path, storageId: file.storageId };
  },
});

/**
 * Mutation: Deletes all stored files under a bucket and path prefix.
 */
export const deleteFilesByPrefix = mutation({
  args: {
    bucket: v.string(),
    prefix: v.string(),
  },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("storedFiles")
      .withIndex("by_bucket", (q) => q.eq("bucket", args.bucket))
      .collect();

    const matched = files.filter((f) => f.path.startsWith(args.prefix));
    const deletedPaths: string[] = [];

    for (const file of matched) {
      try {
        await ctx.storage.delete(file.storageId);
      } catch (err) {
        console.warn(`[ConvexFiles] Could not delete storage object ${file.storageId}:`, err);
      }
      await ctx.db.delete(file._id);
      deletedPaths.push(file.path);
    }

    return { deletedCount: deletedPaths.length, deletedPaths };
  },
});

/**
 * Query: Directly resolves a public serve URL for a given storageId.
 */
export const getUrl = query({
  args: {
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    return toCdnUrl(await ctx.storage.getUrl(args.storageId));
  },
});

/**
 * Migration: Updates all stored files in storedFiles table to use the CDN URL.
 */
export const migrateStoredFileUrlsToCdn = mutation({
  args: {},
  handler: async (ctx) => {
    const files = await ctx.db.query("storedFiles").collect();
    let updated = 0;
    for (const f of files) {
      const cdnUrl = toCdnUrl(f.url ?? null);
      if (cdnUrl && cdnUrl !== f.url) {
        await ctx.db.patch(f._id, { url: cdnUrl });
        updated++;
      }
    }
    return { total: files.length, updated };
  },
});


