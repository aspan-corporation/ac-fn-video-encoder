import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { QueueLambdaConstruct } from "@aspan-corporation/ac-shared-cdk";
import * as path from "path";
import { fileURLToPath } from "node:url";
import * as logs from "aws-cdk-lib/aws-logs";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);

export class AcFnVideoEncoderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Get FFmpeg layer ARN from SSM
    const ffmpegLayerArn = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/layers/ffmpeg/arn",
    );

    // Get centralized log group from monitoring stack
    const centralLogGroupArn = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/monitoring/central-log-group-arn",
    );
    const centralLogGroup = logs.LogGroup.fromLogGroupArn(
      this,
      "CentralLogGroup",
      centralLogGroupArn,
    );

    // Create the Queue + Lambda construct for video encoding processing
    const videoEncoderProcessor = new QueueLambdaConstruct(
      this,
      "VideoEncoderProcessor",
      {
        entry: path.join(currentDirPath, "../src/video-encoder/app.ts"),
        handler: "handler",
        logGroup: centralLogGroup,
        memorySize: 2048,
        timeout: cdk.Duration.minutes(15),
        batchSize: 1, // Process one video at a time
        maxReceiveCount: 3, // Retry up to 3 times before sending to DLQ
        reservedConcurrentExecutions: 15,
        nodejsOptions: {
          ephemeralStorageSize: cdk.Size.mebibytes(2048),
        },
        layers: [
          lambda.LayerVersion.fromLayerVersionArn(
            this,
            "FFmpegLayer",
            ffmpegLayerArn,
          ),
        ],
        environment: {
          LOG_LEVEL: "INFO",
          POWERTOOLS_SERVICE_NAME: "ac-fn-video-encoder",
          DESTINATION_BUCKET_NAME: ssm.StringParameter.valueForStringParameter(
            this,
            "/ac/storage/thumbs-bucket-name",
          ),
          AC_IDEMPOTENCY_TABLE_NAME:
            ssm.StringParameter.valueForStringParameter(
              this,
              "/ac/data/idempotency-table-name",
            ),
          AC_TAU_MEDIA_META_TABLE_NAME:
            ssm.StringParameter.valueForStringParameter(
              this,
              "/ac/data/meta-table-name",
            ),
          CLOUDFRONT_DISTRIBUTION_ID:
            ssm.StringParameter.valueForStringParameter(
              this,
              "/ac/cloudfront/distribution-id",
            ),
        },
      },
    );

    const idempotencyTableName = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/data/idempotency-table-name",
    );

    const idempotencyTableArn = cdk.Arn.format(
      {
        partition: "aws",
        service: "dynamodb",
        region: this.region,
        account: this.account,
        resource: `table/${idempotencyTableName}`,
      },
      this,
    );

    const metaTableNameResolved = "AcDataStack-metadata";
    const metaTableArn = cdk.Arn.format(
      {
        partition: "aws",
        service: "dynamodb",
        region: this.region,
        account: this.account,
        resource: `table/${metaTableNameResolved}`,
      },
      this,
    );

    videoEncoderProcessor.processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:GetItem",
          "dynamodb:DeleteItem",
          "dynamodb:DescribeTable",
          "dynamodb:ConditionCheckItem",
        ],
        resources: [idempotencyTableArn],
      }),
    );

    videoEncoderProcessor.processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:DescribeTable"],
        resources: [metaTableArn],
      }),
    );

    // Allow Lambda to put objects to thumbs bucket
    const thumbsBucketArn = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/storage/thumbs-bucket-arn",
    );

    videoEncoderProcessor.processor.addToRolePolicy(
      new iam.PolicyStatement({
        // GetObject covers the HeadObject we use before encoding to detect
        // whether the destination already exists (for conditional CloudFront
        // invalidation). PutObject is for writing the encoded MP4.
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [`${thumbsBucketArn}/*`],
      }),
    );

    // Allow Lambda to invalidate the encoded video's CloudFront path after
    // overwriting an object in the thumbs bucket. Without this, edge caches
    // continue serving the previous version until natural TTL expiry.
    const cloudFrontDistributionId =
      ssm.StringParameter.valueForStringParameter(
        this,
        "/ac/cloudfront/distribution-id",
      );
    videoEncoderProcessor.processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudfront:CreateInvalidation"],
        resources: [
          `arn:aws:cloudfront::${this.account}:distribution/${cloudFrontDistributionId}`,
        ],
      }),
    );

    // Read grant for the consolidated media bucket (media/ and diary/ alike —
    // /ac/storage/diary-bucket-arn resolves to the same bucket as
    // /ac/storage/media-bucket-name since the cutover to MediaBucket). No
    // cross-account assume-role needed any more; the Lambda's own execution
    // role reads it directly.
    const mediaBucketArn = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/storage/diary-bucket-arn",
    );

    videoEncoderProcessor.processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [`${mediaBucketArn}/*`],
      }),
    );

    // Export the queue URL and ARN for external access
    new ssm.StringParameter(this, "VideoThumbnailProcessingQueueUrlParameter", {
      parameterName: "/ac/video-encoder/queue-url",
      stringValue: videoEncoderProcessor.queue.queueUrl,
    });
    new ssm.StringParameter(this, "VideoEncoderQueueArnParameter", {
      parameterName: "/ac/video-encoder/queue-arn",
      stringValue: videoEncoderProcessor.queue.queueArn,
    });
  }
}
