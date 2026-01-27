import {
  AcContext,
  assertEnvVar,
  getEncodedVideoKey,
  isAllowedVideoExtension,
} from "@aspan-corporation/ac-shared";
import type { S3ObjectCreatedNotificationEvent, SQSRecord } from "aws-lambda";
import createError from "http-errors";
import assert from "node:assert/strict";
import { encodeVideo } from "./encodeVideo.js";

const destinationBucket = assertEnvVar("DESTINATION_BUCKET_NAME");

export const recordHandler = async (
  record: SQSRecord,
  context: AcContext,
): Promise<object> => {
  const { sourceS3Service, destinationS3Service } = context.acServices || {};
  assert(sourceS3Service, "s3Service is required in servicesContext");
  assert(
    destinationS3Service,
    "destinantionS3Service is required in servicesContext",
  );

  const payload = record.body;
  assert(payload, "SQS record has no body");

  const item = JSON.parse(payload);
  const {
    detail: {
      object: { key: sourceKey, size },
      bucket: { name: sourceBucket },
    },
  } = item as S3ObjectCreatedNotificationEvent;

  if (!isAllowedVideoExtension(sourceKey)) {
    throw createError.UnprocessableEntity(
      `extension for ${sourceKey} is not supported`,
    );
  }

  const destinationKey = getEncodedVideoKey({
    key: sourceKey,
  });

  await encodeVideo(
    {
      sourceS3Service,
      sourceBucket,
      sourceKey,
      destinationS3Service,
      destinationBucket,
      destinationKey,
    },
    context,
  );

  return { statusCode: 200, body: "Video encoded successfully" };
};
