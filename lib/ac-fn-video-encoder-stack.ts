import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { QueueLambdaConstruct } from "@aspan-corporation/ac-shared-cdk";
import * as path from "path";
import * as logs from "aws-cdk-lib/aws-logs";

export class AcFnVideoEncoderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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
        environment: {
          LOG_LEVEL: "INFO",
          DESTINATION_BUCKET_NAME: ssm.StringParameter.valueForStringParameter(
            this,
            "/ac/storage/thumbs-bucket-name",
          ),
        },
      },
    );

    // Export the queue URL for external access
    new cdk.CfnOutput(this, "VideoProcessingQueueUrl", {
      value: videoEncoderProcessor.queue.queueUrl,
      description: "URL of the video processing queue",
      exportName: "VideoProcessingQueueUrl",
    });
  }
}
