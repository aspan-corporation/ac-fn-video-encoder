import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { QueueLambdaConstruct } from "@aspan-corporation/ac-shared-cdk";
import * as path from "path";
import * as logs from "aws-cdk-lib/aws-logs";

export class AcFnVideoEncoderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Get FFmpeg layer ARN from SSM
    const ffmpegLayerArn = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/layers/ffmpeg/arn",
    );

    // Create the Queue + Lambda construct for video encoding processing
    const videoEncoderProcessor = new QueueLambdaConstruct(
      this,
      "VideoEncoderProcessor",
      {
        entry: path.join(__dirname, "../src/video-encoder/app.ts"),
        handler: "handler",
        logGroupRemovalPolicy: cdk.RemovalPolicy.DESTROY,
        memorySize: 2048, // More memory for video processing
        timeout: cdk.Duration.minutes(5),
        batchSize: 1, // Process one video at a time
        maxReceiveCount: 3, // Retry up to 3 times before sending to DLQ
        // reservedConcurrentExecutions: 10, // Removed: account doesn't have enough unreserved concurrency
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
          AC_TAU_MEDIA_MEDIA_BUCKET_ACCESS_ROLE_ARN:
            ssm.StringParameter.valueForStringParameter(
              this,
              "/ac/iam/media-bucket-access-role-arn",
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

    // Allow Lambda to assume the S3 media read access role
    videoEncoderProcessor.processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [
          "arn:aws:iam::433003433222:role/aspan-corporation/ac-s3-media-read-access",
        ],
      }),
    );

    // Export the queue URL for external access
    new cdk.CfnOutput(this, "VideoProcessingQueueUrl", {
      value: videoEncoderProcessor.queue.queueUrl,
      description: "URL of the video processing queue",
      exportName: "VideoProcessingQueueUrl",
    });
  }
}
