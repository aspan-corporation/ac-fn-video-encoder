import {
  AcServices,
  assertEnvVar,
  getIdempotencyOptions,
  getPartialResponseHandler,
  S3Service,
  STSService,
  withMiddlewares,
  makeIdempotent,
} from "@aspan-corporation/ac-shared";
import { recordHandler } from "./recordHandler.js";

const region = process.env.AWS_REGION || "us-east-1";
const idempotentRecordHandler = makeIdempotent(
  recordHandler,
  getIdempotencyOptions(assertEnvVar("AC_IDEMPOTENCY_TABLE_NAME"), "messageId"),
);
const partialHandler = getPartialResponseHandler(idempotentRecordHandler);

export const handler = withMiddlewares(partialHandler).use({
  before: async ({ context }) => {
    const { logger } = context;
    const stsService = new STSService({ region, logger });

    const assumeRoleCommandOutput = await stsService.assumeRole({
      RoleArn: assertEnvVar("AC_TAU_MEDIA_MEDIA_BUCKET_ACCESS_ROLE_ARN"),
      RoleSessionName: "extract-meta-data",
    });

    const sourceS3Service = new S3Service({
      region,
      assumeRoleCommandOutput,
      logger,
    });

    const destinationS3Service = new S3Service({
      region,
      logger,
    });

    const acServices: AcServices = {
      sourceS3Service,
      destinationS3Service,
    };

    context.acServices = acServices;
  },
});
