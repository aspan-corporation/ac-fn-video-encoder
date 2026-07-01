/**
 * Pure helpers for the encoder's "already current" skip guard. Kept free of any
 * runtime imports so they can be unit-tested without loading the ESM-only
 * @aspan-corporation/ac-shared package under Jest.
 */

// User-metadata key stamped on the encoded object recording the source object's
// ETag it was produced from. Read back on re-dispatch to skip redundant encodes.
// S3 lowercases and strips the `x-amz-meta-` prefix, so this is the bare key.
export const SOURCE_ETAG_METADATA_KEY = "source-etag";

// S3 ETags are quoted (e.g. `"abc123"`); strip quotes for stable comparison and
// storage (S3 rejects double-quotes in user-metadata values anyway).
export const normalizeEtag = (etag?: string): string | undefined =>
  etag ? etag.replace(/"/g, "") : undefined;

/**
 * True when a prior encode output already exists AND was produced from the
 * exact source bytes we'd encode now (matching, non-empty ETags). A genuine
 * re-upload changes the source ETag, so real edits are not skipped.
 */
export const shouldSkipEncode = ({
  destinationExisted,
  sourceEtag,
  destinationSourceEtag,
}: {
  destinationExisted: boolean;
  sourceEtag?: string;
  destinationSourceEtag?: string;
}): boolean =>
  destinationExisted &&
  !!sourceEtag &&
  destinationSourceEtag === sourceEtag;
