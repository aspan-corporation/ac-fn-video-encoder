import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { QueueLambdaConstruct } from "@aspan-corporation/ac-shared-cdk";
import * as path from "path";

export class AcFnVideoThumbsMakerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create the Queue + Lambda construct for video thumbnail processing
    const videoThumbsProcessor = new QueueLambdaConstruct(
      this,
      "VideoThumbnailProcessor",
      {
        nodejsEntry: path.join(
          __dirname,
          "../src/video-encoder/app.ts"
        ),
        handler: "app.handler",
        memorySize: 2048, // More memory for video processing
        timeout: cdk.Duration.minutes(5),
        batchSize: 1, // Process one video at a time
        maxReceiveCount: 3, // Retry up to 3 times before sending to DLQ
        // reservedConcurrentExecutions: 10, // Removed: account doesn't have enough unreserved concurrency
        environment: {
          LOG_LEVEL: "INFO"
          // Add more environment variables as needed
          // THUMBNAIL_BUCKET: thumbnailBucket.bucketName,
          // THUMBNAIL_COUNT: '3',
        }
      }
    );

    // Export the queue URL for external access
    new cdk.CfnOutput(this, "VideoProcessingQueueUrl", {
      value: videoThumbsProcessor.queue.queueUrl,
      description: "URL of the video processing queue",
      exportName: "VideoProcessingQueueUrl"
    });
  }
}
