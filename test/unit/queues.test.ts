import { merge } from "lodash";
import * as sinon from "sinon";
import { DeleteMessageBatchResult, ReceiveMessageResult, SendMessageBatchResult } from "aws-sdk/clients/sqs";
import * as CloudFormationHelpers from "../../src/CloudFormation";
import { pluginConfigExt, runServerless } from "../utils/runServerless";
import { mockAws } from "../utils/mockAws";

describe("queues", () => {
    afterEach(() => {
        sinon.restore();
    });

    it("should create all required resources", async () => {
        const { cfTemplate, computeLogicalId } = await runServerless({
            fixture: "queues",
            configExt: pluginConfigExt,
            cliArgs: ["package"],
        });
        expect(Object.keys(cfTemplate.Resources)).toStrictEqual([
            "ServerlessDeploymentBucket",
            "ServerlessDeploymentBucketPolicy",
            // Lambda worker
            "EmailsWorkerLogGroup",
            "IamRoleLambdaExecution",
            "EmailsWorkerLambdaFunction",
            // Lambda subscription to SQS
            "EmailsWorkerEventSourceMappingSQSEmailsQueueF057328A",
            // Queues
            "emailsDlq47F8494C",
            "emailsQueueF057328A",
        ]);
        const s = computeLogicalId("emails", "Queue");
        expect(cfTemplate.Resources[s]).toMatchObject({
            DeletionPolicy: "Delete",
            Properties: {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                QueueName: expect.stringMatching(/test-queues-\w+-dev-emails/),
                RedrivePolicy: {
                    deadLetterTargetArn: {
                        "Fn::GetAtt": [computeLogicalId("emails", "Dlq"), "Arn"],
                    },
                    maxReceiveCount: 3,
                },
                VisibilityTimeout: 36,
            },
            Type: "AWS::SQS::Queue",
            UpdateReplacePolicy: "Delete",
        });
        expect(cfTemplate.Resources[computeLogicalId("emails", "Dlq")]).toMatchObject({
            DeletionPolicy: "Delete",
            Properties: {
                MessageRetentionPeriod: 1209600,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                QueueName: expect.stringMatching(/test-queues-\w+-dev-emails-dlq/),
            },
            Type: "AWS::SQS::Queue",
            UpdateReplacePolicy: "Delete",
        });
        expect(cfTemplate.Resources.EmailsWorkerLambdaFunction).toMatchObject({
            DependsOn: ["EmailsWorkerLogGroup"],
            Properties: {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                FunctionName: expect.stringMatching(/test-queues-\w+-dev-emailsWorker/),
                Handler: "worker.handler",
                MemorySize: 1024,
                Role: {
                    "Fn::GetAtt": ["IamRoleLambdaExecution", "Arn"],
                },
                Runtime: "nodejs12.x",
                Timeout: 6,
            },
            Type: "AWS::Lambda::Function",
        });
        expect(cfTemplate.Resources.EmailsWorkerEventSourceMappingSQSEmailsQueueF057328A).toEqual({
            DependsOn: ["IamRoleLambdaExecution"],
            Properties: {
                BatchSize: 1,
                Enabled: true,
                EventSourceArn: {
                    "Fn::GetAtt": [computeLogicalId("emails", "Queue"), "Arn"],
                },
                FunctionName: {
                    "Fn::GetAtt": ["EmailsWorkerLambdaFunction", "Arn"],
                },
                MaximumBatchingWindowInSeconds: 60,
            },
            Type: "AWS::Lambda::EventSourceMapping",
        });
        expect(cfTemplate.Outputs).toMatchObject({
            [computeLogicalId("emails", "QueueArn")]: {
                Description: 'ARN of the "emails" SQS queue.',
                Value: {
                    "Fn::GetAtt": [computeLogicalId("emails", "Queue"), "Arn"],
                },
            },
            [computeLogicalId("emails", "QueueUrl")]: {
                Description: 'URL of the "emails" SQS queue.',
                Value: {
                    Ref: computeLogicalId("emails", "Queue"),
                },
            },
        });
        // Lambda functions of the app are authorized to publish to SQS
        expect(cfTemplate.Resources.IamRoleLambdaExecution).toMatchObject({
            Type: "AWS::IAM::Role",
            Properties: {
                Policies: [
                    {
                        PolicyDocument: {
                            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                            Statement: expect.arrayContaining([
                                {
                                    Action: "sqs:SendMessage",
                                    Effect: "Allow",
                                    Resource: [
                                        {
                                            "Fn::GetAtt": [computeLogicalId("emails", "Queue"), "Arn"],
                                        },
                                    ],
                                },
                            ]),
                        },
                    },
                ],
            },
        });
    });

    it("sets the SQS visibility timeout to 6 times the function timeout", async () => {
        const { cfTemplate, computeLogicalId } = await runServerless({
            fixture: "queues",
            configExt: merge(pluginConfigExt, {
                constructs: {
                    emails: {
                        worker: {
                            timeout: 7,
                        },
                    },
                },
            }),
            cliArgs: ["package"],
        });
        expect(cfTemplate.Resources[computeLogicalId("emails", "Queue")]).toMatchObject({
            Properties: {
                VisibilityTimeout: 7 * 6,
            },
        });
        expect(cfTemplate.Resources.EmailsWorkerLambdaFunction).toMatchObject({
            Properties: {
                Timeout: 7,
            },
        });
    });

    it("allows changing the number of retries", async () => {
        const { cfTemplate, computeLogicalId } = await runServerless({
            fixture: "queues",
            configExt: merge(pluginConfigExt, {
                constructs: {
                    emails: {
                        maxRetries: 1,
                    },
                },
            }),
            cliArgs: ["package"],
        });
        expect(cfTemplate.Resources[computeLogicalId("emails", "Queue")]).toMatchObject({
            Properties: {
                RedrivePolicy: {
                    maxReceiveCount: 1,
                },
            },
        });
    });

    it("allows changing the batch size", async () => {
        const { cfTemplate } = await runServerless({
            fixture: "queues",
            configExt: merge(pluginConfigExt, {
                constructs: {
                    emails: {
                        batchSize: 10,
                    },
                },
            }),
            cliArgs: ["package"],
        });
        expect(cfTemplate.Resources.EmailsWorkerEventSourceMappingSQSEmailsQueueF057328A).toMatchObject({
            Properties: {
                BatchSize: 10,
            },
        });
    });

    it("allows defining a DLQ email alarm", async () => {
        const { cfTemplate, computeLogicalId } = await runServerless({
            fixture: "queues",
            configExt: merge(pluginConfigExt, {
                constructs: {
                    emails: {
                        alarm: "alerting@example.com",
                    },
                },
            }),
            cliArgs: ["package"],
        });
        expect(Object.keys(cfTemplate.Resources)).toStrictEqual([
            "ServerlessDeploymentBucket",
            "ServerlessDeploymentBucketPolicy",
            "EmailsWorkerLogGroup",
            "IamRoleLambdaExecution",
            "EmailsWorkerLambdaFunction",
            "EmailsWorkerEventSourceMappingSQSEmailsQueueF057328A",
            "emailsDlq47F8494C",
            "emailsQueueF057328A",
            // Alarm
            "emailsAlarmTopic594BAEC9",
            "emailsAlarmTopicSubscription688AECB6",
            "emailsAlarm1821C14F",
        ]);
        expect(cfTemplate.Resources[computeLogicalId("emails", "Alarm")]).toMatchObject({
            Properties: {
                AlarmActions: [
                    {
                        Ref: computeLogicalId("emails", "AlarmTopic"),
                    },
                ],
                AlarmDescription: "Alert triggered when there are failed jobs in the dead letter queue.",
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                AlarmName: expect.stringMatching(/test-queues-\w+-dev-emails-dlq-alarm/),
                ComparisonOperator: "GreaterThanThreshold",
                Dimensions: [
                    {
                        Name: "QueueName",
                        Value: {
                            "Fn::GetAtt": [computeLogicalId("emails", "Dlq"), "QueueName"],
                        },
                    },
                ],
                EvaluationPeriods: 1,
                MetricName: "ApproximateNumberOfMessagesVisible",
                Namespace: "AWS/SQS",
                Period: 60,
                Statistic: "Sum",
                Threshold: 0,
            },
        });
        expect(cfTemplate.Resources[computeLogicalId("emails", "AlarmTopic")]).toMatchObject({
            Properties: {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                TopicName: expect.stringMatching(/test-queues-\w+-dev-emails-dlq-alarm-topic/),
                DisplayName: "[Alert][emails] There are failed jobs in the dead letter queue.",
            },
        });
        expect(cfTemplate.Resources[computeLogicalId("emails", "AlarmTopicSubscription")]).toMatchObject({
            Properties: {
                Endpoint: "alerting@example.com",
                Protocol: "email",
                TopicArn: {
                    Ref: computeLogicalId("emails", "AlarmTopic"),
                },
            },
        });
    });

    it("should purge messages from the DLQ", async () => {
        const awsMock = mockAws();
        sinon.stub(CloudFormationHelpers, "getStackOutput").returns(Promise.resolve("queue-url"));
        awsMock.mockService("SQS", "purgeQueue");
        const purgeSpy = awsMock.mockService("SQS", "purgeQueue").returns(Promise.resolve());

        await runServerless({
            fixture: "queues",
            configExt: pluginConfigExt,
            cliArgs: ["emails:failed:purge"],
        });

        // TODO simplify `.args[2]`
        expect(purgeSpy.firstCall.args[2]).toStrictEqual({
            QueueUrl: "queue-url",
        });
    });

    it("should not do anything if there are no failed messages to retry", async () => {
        const awsMock = mockAws();
        sinon.stub(CloudFormationHelpers, "getStackOutput").returns(Promise.resolve("queue-url"));
        awsMock.mockService("SQS", "receiveMessage").returns(
            Promise.resolve({
                Messages: [],
            })
        );
        const sendSpy = awsMock.mockService("SQS", "sendMessageBatch").returns(Promise.resolve());
        const deleteSpy = awsMock.mockService("SQS", "deleteMessageBatch").returns(Promise.resolve());

        await runServerless({
            fixture: "queues",
            configExt: pluginConfigExt,
            cliArgs: ["emails:failed:retry"],
        });

        expect(sendSpy.callCount).toBe(0);
        expect(deleteSpy.callCount).toBe(0);
    });

    it("should retry messages from the DLQ", async () => {
        const awsMock = mockAws();
        const stackOutputStub = sinon.stub(CloudFormationHelpers, "getStackOutput");
        stackOutputStub.onFirstCall().returns(Promise.resolve("queue-url"));
        stackOutputStub.onSecondCall().returns(Promise.resolve("dlq-url"));
        const receiveStub = awsMock.mockService("SQS", "receiveMessage");
        // First call: 1 message is found
        const sqsResponse: ReceiveMessageResult = {
            Messages: [
                {
                    MessageId: "abcd",
                    Body: "sample body",
                    ReceiptHandle: "abcd-handle",
                    Attributes: {},
                    MessageAttributes: {},
                },
            ],
        };
        receiveStub.onFirstCall().returns(Promise.resolve(sqsResponse));
        // On next calls: no messages found
        receiveStub.returns(
            Promise.resolve({
                Messages: [],
            })
        );
        const sendResult: SendMessageBatchResult = {
            Successful: [
                {
                    Id: "abcd",
                    MessageId: "abcd",
                    MD5OfMessageBody: "",
                },
            ],
            Failed: [],
        };
        const sendSpy = awsMock.mockService("SQS", "sendMessageBatch").returns(Promise.resolve(sendResult));
        const deleteResult: DeleteMessageBatchResult = {
            Successful: [
                {
                    Id: "abcd",
                },
            ],
            Failed: [],
        };
        const deleteSpy = awsMock.mockService("SQS", "deleteMessageBatch").returns(Promise.resolve(deleteResult));

        await runServerless({
            fixture: "queues",
            configExt: pluginConfigExt,
            cliArgs: ["emails:failed:retry"],
        });

        // The failed message should have been "sent" to the main queue
        expect(sendSpy.callCount).toBe(1);
        expect(sendSpy.firstCall.args[2]).toStrictEqual({
            QueueUrl: "queue-url",
            Entries: [
                {
                    Id: "abcd",
                    MessageBody: "sample body",
                    MessageAttributes: {},
                },
            ],
        });
        // The failed message should have been "deleted" from the dead letter queue
        expect(deleteSpy.callCount).toBe(1);
        expect(deleteSpy.firstCall.args[2]).toStrictEqual({
            QueueUrl: "dlq-url",
            Entries: [
                {
                    Id: "abcd",
                    ReceiptHandle: "abcd-handle",
                },
            ],
        });
    });
});
