import { AcContext, MetricUnit, S3Service } from "@aspan-corporation/ac-shared";
import { spawn } from "child_process";

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

/**
 * Detect the video codec of the source file using ffprobe.
 */
const detectVideoCodec = async (
  signedUrl: string,
): Promise<string> => {
  const ffprobe = spawn(FFPROBE_PATH, [
    "-i", signedUrl,
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name",
    "-v", "quiet",
    "-of", "csv=p=0",
  ], { timeout: 270000 });

  return new Promise((resolve, reject) => {
    let output = "";
    ffprobe.stdout.on("data", (d) => { output += d.toString(); });
    ffprobe.on("close", (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`ffprobe exited with code ${code}`));
    });
    ffprobe.on("error", reject);
  });
};

/**
 * Re-mux or re-encode a video into fragmented MP4 for browser streaming.
 * - h264 sources: re-mux only (-c copy), completes in seconds
 * - hevc/other sources: re-encode to h264 for MSE compatibility
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

  const codec = await detectVideoCodec(signedSourceUrl);
  const canCopyStream = codec === "h264";
  logger.debug("detected video codec", { codec, canCopyStream });

  const { stream, done } = destinationS3Service.createS3UploadStream({
    Bucket: destinationBucket,
    Key: destinationKey,
  });

  const ffmpegArgs = [
    "-i", signedSourceUrl,
    ...(canCopyStream
      ? ["-c", "copy"]
      : ["-c:v", "libx264", "-preset", "fast", "-c:a", "aac", "-b:a", "128k"]),
    "-movflags", "frag_keyframe+default_base_moof",
    "-f", "mp4",
    "pipe:1",
  ];

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
    logger.error("FFmpeg stderr output", { lastStderr, exitCode });
    throw new Error(`FFmpeg failed with code ${exitCode}: ${lastStderr}`);
  }

  await done;

  logger.debug("VideoEncodingsFinished", {
    exitCode,
    sourceKey,
    codec,
    canCopyStream,
  });
  metrics.addMetric("VideoEncodingsFinished", MetricUnit.Count, 1);

  logger.debug("uploaded encoded video", { sourceKey, destinationKey });
};
