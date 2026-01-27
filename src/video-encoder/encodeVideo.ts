import { AcContext, MetricUnit, S3Service } from "@aspan-corporation/ac-shared";
import { spawn } from "child_process";

const FFMPEG_PATH = "/opt/bin/ffmpeg";
type EncodeVideoParams = {
  sourceS3Service: S3Service;
  sourceBucket: string;
  sourceKey: string;
  destinationS3Service: S3Service;
  destinationBucket: string;
  destinationKey: string;
};

/**
 * Resizes an image and uploads it to S3. Output is always in JPEG format.
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

  const { stream, done } = destinationS3Service.createS3UploadStream({
    Bucket: destinationBucket,
    Key: destinationKey,
  });

  const signedSourceUrl = await sourceS3Service.getSignedUrl({
    Bucket: sourceBucket,
    Key: sourceKey,
  });

  const ffmpeg = spawn(FFMPEG_PATH, [
    "-i",
    signedSourceUrl,
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-f",
    "mp4",
    "pipe:1",
  ]);

  ffmpeg.stdout.pipe(stream);

  ffmpeg.stderr.on("data", (d) => {
    // !d.toString().includes("frame=") && logger.info(d.toString());
  });

  const exitCode = await new Promise((resolve, reject) => {
    ffmpeg.on("close", resolve);
    ffmpeg.on("error", reject);
  });

  if (exitCode !== 0) {
    throw new Error(`FFmpeg failed with code ${exitCode}`);
  }

  await done;

  logger.debug("VideoEncodingsFinished", {
    exitCode,
    sourceKey,
  });
  metrics.addMetric("VideoEncodingsFinished", MetricUnit.Count, 1);

  logger.debug("uploaded encoded video", { sourceKey, destinationKey });
};
