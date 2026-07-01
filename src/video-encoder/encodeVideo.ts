import { AcContext, MetricUnit, S3Service } from "@aspan-corporation/ac-shared";
import { spawn } from "child_process";
import { invalidateCloudFrontPath } from "./invalidateCloudFront.js";
import {
  SOURCE_ETAG_METADATA_KEY,
  normalizeEtag,
  shouldSkipEncode,
} from "./encodeSkip.js";

const FFMPEG_PATH = "/opt/bin/ffmpeg";
const FFPROBE_PATH = "/opt/bin/ffprobe";

type EncodeVideoParams = {
  sourceS3Service: S3Service;
  sourceBucket: string;
  sourceKey: string;
  destinationS3Service: S3Service;
  destinationBucket: string;
  destinationKey: string;
};

type SourceProbe = {
  /** Video codec name (e.g. "h264", "hevc", "prores") or null if no video stream. */
  video: string | null;
  /** Video stream pixel format (e.g. "yuv420p", "yuvj422p") or null. */
  pixFmt: string | null;
  /** Audio codec name (e.g. "aac", "pcm_s16le") or null if no audio stream. */
  audio: string | null;
  /** Side-data rotation angle (0 / 90 / 180 / 270). */
  rotation: number;
};

// Pixel formats Apple's hardware H.264 decoder can play: 8-bit 4:2:0 only.
// iOS (Safari on iPhone/iPad) rejects 4:2:2 / 4:4:4 / 10-bit H.264 even though
// desktop browsers software-decode them — so we may stream-copy h264 ONLY when
// it is already one of these, and otherwise re-encode down to yuv420p.
const IOS_SAFE_PIX_FMTS = new Set(["yuv420p", "yuvj420p"]);

/**
 * Probe the source in a single ffprobe pass:
 *   - first video stream's codec_name
 *   - first audio stream's codec_name
 *   - side-data rotation tag on the video stream
 *
 * Returns nulls for streams that don't exist (silent video → audio=null,
 * audio-only mistakenly uploaded with .mov → video=null).
 */
const probeSource = async (signedUrl: string): Promise<SourceProbe> => {
  const ffprobe = spawn(FFPROBE_PATH, [
    "-i", signedUrl,
    "-show_entries", "stream=codec_type,codec_name,pix_fmt:stream_side_data=rotation",
    "-v", "quiet",
    "-of", "json",
  ], { timeout: 60000 });

  return new Promise((resolve, reject) => {
    let output = "";
    ffprobe.stdout.on("data", (d) => { output += d.toString(); });
    ffprobe.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(output) as {
          streams: Array<{
            codec_type: string;
            codec_name: string;
            pix_fmt?: string;
            side_data_list?: Array<{ rotation?: number }>;
          }>;
        };
        const videoStream = parsed.streams.find((s) => s.codec_type === "video");
        const audioStream = parsed.streams.find((s) => s.codec_type === "audio");
        const rawRotation = videoStream?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation;
        const rotation = typeof rawRotation === "number"
          ? ((rawRotation % 360) + 360) % 360
          : 0;
        resolve({
          video: videoStream?.codec_name ?? null,
          pixFmt: videoStream?.pix_fmt ?? null,
          audio: audioStream?.codec_name ?? null,
          rotation,
        });
      } catch {
        reject(new Error("Failed to parse ffprobe JSON output"));
      }
    });
    ffprobe.on("error", reject);
  });
};

/** Map rotation angle to FFmpeg transpose filter arguments. */
const rotationToVf = (degrees: number): string[] => {
  switch (degrees) {
    case 90:  return ["-vf", "transpose=1"];
    case 180: return ["-vf", "transpose=1,transpose=1"];
    case 270: return ["-vf", "transpose=2"];
    default:  return [];
  }
};

/**
 * Re-mux or re-encode a video into fragmented MP4 for browser streaming
 * via Media Source Extensions (MSE).
 *
 * MSE compatibility is guaranteed by construction:
 *   - Video out: h264. Either -c:v copy (source already h264, no rotation) or
 *     -c:v libx264. Both produce h264.
 *   - Audio out: AAC. -c:a aac transcodes any source audio codec (PCM, ipcm,
 *     opus, …) into AAC. Silent sources stay silent.
 *
 * Upfront source probe rejects unencodable inputs early (no video stream)
 * before we burn ffmpeg time. Anything else — including exotic source audio
 * codecs — is handled by ffmpeg's transcoders.
 *
 * If ffmpeg fails (non-zero exit), the error propagates and the SQS record
 * is retried up to maxReceiveCount times before being routed to the DLQ.
 */
export const encodeVideo = async (
  {
    sourceBucket,
    sourceKey,
    destinationBucket,
    destinationKey,
    destinationS3Service,
    sourceS3Service,
  }: EncodeVideoParams,
  { logger, metrics }: AcContext,
) => {
  logger.debug("VideoEncodingsStarted", { sourceKey });
  metrics.addMetric("VideoEncodingsStarted", MetricUnit.Count, 1);

  // Identify the exact source bytes so we can tell whether an existing encoded
  // output was produced from this same version. HeadObject is a few-ms call.
  const sourceHead = await sourceS3Service
    .headObject({ Bucket: sourceBucket, Key: sourceKey })
    .catch(() => undefined); // defensive: never block the encode on this probe
  const sourceEtag = normalizeEtag(sourceHead?.ETag);

  // Head the destination once. Its existence drives the CDN-invalidation
  // decision below; the stored `source-etag` metadata lets us skip re-encoding
  // entirely when the output is already current for this source.
  //   - existed  → re-encode (overwriting): invalidate to evict stale cache
  //   - !existed → first-time encode: no cache entry to evict, skip invalidate
  // Trade-off on the invalidation skip: if anything fetched the destination URL
  // between source upload and encoder completion, CloudFront may have cached a
  // 404 (default negative TTL 10s) that lingers until natural expiry.
  const destinationHead = await destinationS3Service
    .headObject({ Bucket: destinationBucket, Key: destinationKey })
    .catch(() => undefined);
  const destinationExisted = destinationHead !== undefined;
  const destinationSourceEtag = normalizeEtag(
    destinationHead?.Metadata?.[SOURCE_ETAG_METADATA_KEY],
  );

  // ── Skip guard ──────────────────────────────────────────────────────────
  // A re-dispatch of the whole library (or a duplicate S3 event) arrives with
  // a fresh SQS messageId, so the idempotency layer does NOT dedupe it. Without
  // this guard every such replay re-encodes every video (minutes of 2GB Lambda
  // each). When the encoded output already carries the current source ETag, the
  // bytes are unchanged and there is nothing to do. A genuine re-upload changes
  // the source ETag, so real edits still re-encode.
  if (shouldSkipEncode({ destinationExisted, sourceEtag, destinationSourceEtag })) {
    logger.info("Skipping encode — destination already current for source", {
      sourceKey,
      destinationKey,
      sourceEtag,
    });
    metrics.addMetric("VideoEncodingsSkippedCurrent", MetricUnit.Count, 1);
    return;
  }

  const signedSourceUrl = await sourceS3Service.getSignedUrl({
    Bucket: sourceBucket,
    Key: sourceKey,
  });

  // ── Upfront source probe ────────────────────────────────────────────────
  const probe = await probeSource(signedSourceUrl);
  logger.debug("source probe", { sourceKey, ...probe, destinationExisted });

  // Fail fast: a file with no video stream is unencodable to a video MP4.
  // This routes corrupt or mistakenly-uploaded files to the DLQ without
  // spending the full ffmpeg encode budget on them first.
  if (!probe.video) {
    metrics.addMetric("VideoEncodingsSourceUnencodable", MetricUnit.Count, 1);
    throw new Error(
      `Source ${sourceKey} has no video stream (audio=${probe.audio ?? "none"}). ` +
      `Cannot encode to MSE-compatible MP4. Will be routed to DLQ.`,
    );
  }

  const vfArgs = rotationToVf(probe.rotation);
  // Stream-copy h264 only when it is ALSO in an iOS-decodable pixel format
  // (8-bit 4:2:0). Copying a High 4:2:2 / 4:4:4 / 10-bit h264 source produced
  // files that played on desktop but not on iPhone — Apple's hardware decoder
  // only handles 4:2:0. When the pix_fmt isn't iOS-safe we re-encode instead.
  const canCopyVideo =
    probe.video === "h264" &&
    vfArgs.length === 0 &&
    probe.pixFmt !== null &&
    IOS_SAFE_PIX_FMTS.has(probe.pixFmt);
  const canCopyAudio = probe.audio === "aac"; // already AAC → stream-copy

  logger.debug("encode plan", {
    sourceVideo: probe.video,
    sourcePixFmt: probe.pixFmt,
    sourceAudio: probe.audio,
    rotation: probe.rotation,
    canCopyVideo,
    canCopyAudio,
  });

  // ── Build encode args ───────────────────────────────────────────────────
  // Both flags are chosen to GUARANTEE MSE-compatible output:
  //   video → h264 (either via copy when already h264, or libx264)
  //   audio → aac  (either via copy when already AAC, or aac encoder)
  // Silent sources stay silent — MSE handles that fine.
  // On re-encode, force 8-bit 4:2:0 High profile so the result is decodable by
  // iOS hardware (libx264 would otherwise preserve a 4:2:2/4:4:4/10-bit source
  // pixel format, which iPhone Safari can't play). `-pix_fmt yuv420p` does the
  // chroma downsample; `-profile:v high` keeps it explicit.
  const videoArgs = canCopyVideo
    ? ["-c:v", "copy"]
    : ["-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p", "-profile:v", "high", ...vfArgs];

  const audioArgs = probe.audio === null
    ? [] // no audio stream — don't specify -c:a
    : canCopyAudio
      ? ["-c:a", "copy"]
      : ["-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k"];

  const ffmpegArgs = [
    "-i", signedSourceUrl,
    ...videoArgs,
    ...audioArgs,
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "pipe:1",
  ];

  // ── Run encode, piping ffmpeg stdout straight to S3 ─────────────────────
  const { stream, done } = destinationS3Service.createS3UploadStream({
    Bucket: destinationBucket,
    Key: destinationKey,
    ContentType: "video/mp4",
    // Stamp the source ETag so a future re-dispatch can detect this output is
    // already current and skip the encode (see the skip guard above).
    ...(sourceEtag
      ? { Metadata: { [SOURCE_ETAG_METADATA_KEY]: sourceEtag } }
      : {}),
  });

  // ffmpeg timeout sits just under the Lambda's 900s limit (with headroom for
  // the final S3 upload + teardown). The old 270s cap killed long re-encodes —
  // e.g. a 1080p 10-bit HEVC source that must be transcoded to 8-bit h264 takes
  // several minutes on a 2GB Lambda — so those silently failed and retried.
  const ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs, { timeout: 840000 });
  ffmpeg.stdout.pipe(stream);

  const stderrLines: string[] = [];
  const MAX_STDERR_LINES = 50;
  ffmpeg.stderr.on("data", (d) => {
    const line = d.toString();
    stderrLines.push(line);
    if (stderrLines.length > MAX_STDERR_LINES) stderrLines.shift();
    if (!line.includes("frame=")) logger.info(line);
  });

  let settled = false;
  const exitCode = await new Promise((resolve, reject) => {
    ffmpeg.on("close", (code) => { if (!settled) { settled = true; resolve(code); } });
    ffmpeg.on("error", (err) => { if (!settled) { settled = true; reject(err); } });
  });

  if (exitCode !== 0) {
    const lastStderr = stderrLines.slice(-5).join("\n");
    logger.error("FFmpeg failed", { lastStderr, exitCode, sourceKey });
    throw new Error(`FFmpeg failed with code ${exitCode}: ${lastStderr}`);
  }

  await done;

  // Invalidate the CDN cache ONLY when we just overwrote an existing object.
  // First-time encodes don't need invalidation since nothing was cached.
  // Non-fatal — failures are logged but don't error out the encode, since
  // the S3 write has already succeeded.
  if (destinationExisted) {
    await invalidateCloudFrontPath(destinationKey, { logger, metrics } as AcContext);
  } else {
    logger.debug("Skipping CloudFront invalidation — first-time encode", { destinationKey });
    metrics.addMetric("CloudFrontInvalidationsSkipped", MetricUnit.Count, 1);
  }

  logger.debug("VideoEncodingsFinished", {
    sourceKey,
    destinationKey,
    sourceVideo: probe.video,
    sourceAudio: probe.audio,
    canCopyVideo,
    canCopyAudio,
  });
  metrics.addMetric("VideoEncodingsFinished", MetricUnit.Count, 1);
};
