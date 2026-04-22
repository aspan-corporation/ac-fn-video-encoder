import {
  AcContext,
  assertEnvVar,
  getEncodedVideoKey,
  isAllowedVideoExtension,
} from "@aspan-corporation/ac-shared";
import type { S3ObjectCreatedNotificationEvent, SQSRecord } from "aws-lambda";
import assert from "node:assert/strict";
import { encodeVideo } from "./encodeVideo.js";

const destinationBucket = assertEnvVar("DESTINATION_BUCKET_NAME");
const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");
const TAG_HIDDEN = "ac:ediacara:hidden";

export const recordHandler = async (
  record: SQSRecord,
  context: AcContext,
): Promise<void> => {
  const { sourceS3Service, destinationS3Service, dynamoDBService } = context.acServices || {};
  assert(sourceS3Service, "s3Service is required in servicesContext");
  assert(destinationS3Service, "destinantionS3Service is required in servicesContext");
  assert(dynamoDBService, "dynamoDBService is required in servicesContext");

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
    throw new Error(`extension for ${sourceKey} is not supported`);
  }

  const { Item: metaItem } = await dynamoDBService.getCommand({
    TableName: metaTableName,
    Key: { id: sourceKey },
  });
  if ((metaItem?.tags as { key: string }[] | undefined)?.some((t) => t.key === TAG_HIDDEN)) {
    context.logger.info("Skipping hidden file", { sourceKey });
    return;
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
};
