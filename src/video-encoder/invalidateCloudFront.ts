import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { AcContext, MetricUnit } from "@aspan-corporation/ac-shared";

const client = new CloudFrontClient({});

/**
 * Invalidate the CloudFront cache for a single object path after the
 * encoder overwrites an existing object in the thumbs bucket.
 *
 * The caller (encodeVideo.ts) only invokes this on re-encodes — i.e. when
 * a HeadObject before the upload returned `exists`. First-time encodes
 * skip the invalidation entirely because nothing is cached yet.
 *
 * Failure mode:
 *   We do NOT throw if invalidation fails. The encoded file has already
 *   been written to S3 successfully — letting the SQS message retry just
 *   re-runs the expensive ffmpeg work for a cache-invalidation problem.
 *   Instead we log + emit a metric so it's visible.
 */
export const invalidateCloudFrontPath = async (
  encodedKey: string,
  { logger, metrics }: AcContext,
): Promise<void> => {
  const distributionId = process.env.CLOUDFRONT_DISTRIBUTION_ID;
  if (!distributionId) {
    logger.warn("CLOUDFRONT_DISTRIBUTION_ID not set — skipping invalidation", { encodedKey });
    return;
  }

  // CloudFront invalidation paths must start with "/" and be URL-encoded
  // exactly the way the viewer would request them. The viewer uses
  // encodeURIComponent on each path segment, which preserves "/" and encodes
  // spaces as %20, parentheses, etc. encodeURI() does the equivalent here.
  const path = "/" + encodeURI(encodedKey);

  try {
    const out = await client.send(new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        // Unique per call — Date.now() + path is fine for our throughput
        // (≤15 concurrent encodes, idempotent SQS records prevent floods).
        CallerReference: `enc-${Date.now()}-${encodedKey}`,
        Paths: { Quantity: 1, Items: [path] },
      },
    }));
    logger.debug("CloudFront invalidation created", {
      encodedKey,
      path,
      invalidationId: out.Invalidation?.Id,
    });
    metrics.addMetric("CloudFrontInvalidationsCreated", MetricUnit.Count, 1);
  } catch (err) {
    // Swallow — the encode already succeeded. Re-running would waste compute.
    logger.error("CloudFront invalidation failed (non-fatal)", {
      encodedKey,
      path,
      err: err instanceof Error ? err.message : String(err),
    });
    metrics.addMetric("CloudFrontInvalidationsFailed", MetricUnit.Count, 1);
  }
};
