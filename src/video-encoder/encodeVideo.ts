import { AcContext, MetricUnit, S3Service } from "@aspan-corporation/ac-shared";
import { spawn } from "child_process";
import { invalidateCloudFrontPath } from "./invalidateCloudFront.js";

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
  /** Audio codec name (e.g. "aac", "pcm_s16le") or null if no audio stream. */
  audio: string | null;
  /** Side-data rotation angle (0 / 90 / 180 / 270). */
  rotation: number;
};

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
    "-show_entries", "stream=codec_type,codec_name:stream_side_data=rotation",
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

  const signedSourceUrl = await sourceS3Service.getSignedUrl({
    Bucket: sourceBucket,
    Key: sourceKey,
  });

  // Check upfront whether the encoded destination already exists. We use
  // this signal AFTER the upload to decide whether to invalidate the CDN:
  //   - existed  → re-encode (overwriting): invalidate to evict stale cache
  //   - !existed → first-time encode: no cache entry to evict, skip invalidate
  //
  // Saves a CreateInvalidation API call per first-time upload (cheap at our
  // scale, but free is free and it keeps the invalidation history clean).
  // The HeadObject is a few-ms add to the encode budget — negligible.
  //
  // Trade-off: if anything fetched the destination URL between source
  // upload and encoder completion, CloudFront may have cached a 404 (default
  // negative-cache TTL is 10s). That stale 404 will linger until natural
  // TTL expiry instead of being cleared by an invalidation. Acceptable for
  // first-time encodes where users typically aren't watching for the file.
  const destinationExisted = await destinationS3Service
    .checkIfObjectExists({
      Bucket: destinationBucket,
      Key: destinationKey,
    })
    .catch(() => false); // defensive: a failed check should not block encoding

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
  const canCopyVideo = probe.video === "h264" && vfArgs.length === 0;
  const canCopyAudio = probe.audio === "aac"; // already AAC → stream-copy

  logger.debug("encode plan", {
    sourceVideo: probe.video,
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
  const videoArgs = canCopyVideo
    ? ["-c:v", "copy"]
    : ["-c:v", "libx264", "-preset", "fast", ...vfArgs];

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
  });

  const ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs, { timeout: 270000 });
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
