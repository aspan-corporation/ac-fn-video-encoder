import {
  AcServices,
  assertEnvVar,
  DynamoDBService,
  getIdempotencyOptions,
  getPartialResponseHandler,
  S3Service,
  withMiddlewares,
  makeIdempotent,
} from "@aspan-corporation/ac-shared";
import type { Handler } from "aws-lambda";
import { recordHandler } from "./recordHandler.js";

const region = process.env.AWS_REGION || "us-east-1";
const idempotentRecordHandler = makeIdempotent(
  recordHandler,
  getIdempotencyOptions(assertEnvVar("AC_IDEMPOTENCY_TABLE_NAME"), "messageId"),
);
const partialHandler = getPartialResponseHandler(idempotentRecordHandler);

export const handler: Handler = withMiddlewares(partialHandler).use({
  before: async ({ context }) => {
    const { logger } = context;

    // The media library and the diary both live in the same consolidated
    // bucket now (see MediaBucket, AcAppStack) — the Lambda's own execution
    // role is granted GetObject directly (see the stack's diaryBucketArn
    // grant, which covers the whole bucket since that SSM value now points
    // here too). No cross-account assume-role needed any more.
    const sourceS3Service = new S3Service({ region, logger });

    const destinationS3Service = new S3Service({
      region,
      logger,
    });

    const dynamoDBService = new DynamoDBService({ region, logger });

    const acServices: AcServices = {
      sourceS3Service,
      destinationS3Service,
      dynamoDBService,
    };

    context.acServices = acServices;
  },
});
