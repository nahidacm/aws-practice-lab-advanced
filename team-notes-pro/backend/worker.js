// Stage 5 — SQS export worker.
// Runs as a separate ECS service using the same Docker image as the API (different CMD).
// Reads export_jobs from SQS, generates a Markdown file, uploads to S3, updates the DB.

const {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} = require('@aws-sdk/client-sqs');
const {
  S3Client,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { createPool } = require('./db');

const QUEUE_URL     = process.env.SQS_QUEUE_URL;
const EXPORT_BUCKET = process.env.EXPORT_BUCKET;
const REGION        = process.env.AWS_REGION || 'us-east-1';

const sqs = new SQSClient({ region: REGION });
const s3  = new S3Client({ region: REGION });
// sns is optional — omitting SNS_TOPIC_ARN disables notifications without breaking the worker
const sns = process.env.SNS_TOPIC_ARN ? new SNSClient({ region: REGION }) : null;

let pool;

// --- Export generation ---

function generateMarkdown(rows, userEmail) {
  const header = [
    '# Team Notes Pro Export',
    `User: ${userEmail}`,
    `Exported: ${new Date().toISOString()}`,
    `Notes: ${rows.length}`,
    '',
  ];

  const body = rows.flatMap((row) => [
    '---',
    '',
    `## ${row.title}`,
    `*${new Date(row.created_at).toLocaleDateString('en-US', { dateStyle: 'medium' })}*`,
    '',
    row.content,
    '',
  ]);

  return [...header, ...body].join('\n');
}

// --- SNS notification (Stage 7) ---
//
// The worker publishes one event per job outcome. SNS fans it out to every
// subscriber (email, SQS queue, Lambda, SMS…) without the worker knowing or
// caring what's listening. Add a new subscriber in the console — zero code changes.
//
// Notification event shape:
// {
//   "event":       "export.completed" | "export.failed",
//   "jobId":       "uuid",
//   "userId":      "cognito-sub",
//   "userEmail":   "user@example.com",
//   "noteCount":   5,          // export.completed only
//   "completedAt": "ISO8601",  // export.completed only
//   "error":       "...",      // export.failed only
//   "failedAt":    "ISO8601"   // export.failed only
// }

async function publishEvent(payload) {
  if (!sns) return; // graceful no-op — SNS_TOPIC_ARN not configured
  try {
    await sns.send(new PublishCommand({
      TopicArn: process.env.SNS_TOPIC_ARN,
      // Subject is used as the email subject line for email subscribers
      Subject:  payload.event === 'export.completed'
        ? `Export ready — ${payload.noteCount} note${payload.noteCount !== 1 ? 's' : ''}`
        : `Export failed`,
      Message:  JSON.stringify(payload, null, 2),
      // MessageAttributes let future subscribers filter by event type without parsing the body
      MessageAttributes: {
        event: { DataType: 'String', StringValue: payload.event },
      },
    }));
    console.log(`[${payload.jobId}] SNS published: ${payload.event}`);
  } catch (err) {
    // Non-fatal — the job is already marked complete/failed in the DB
    console.error(`[${payload.jobId}] SNS publish failed:`, err.message);
  }
}

// --- Job processing ---

async function processJob(jobId, userId) {
  await pool.query("UPDATE export_jobs SET status = 'processing' WHERE id = $1", [jobId]);
  console.log(`[${jobId}] processing`);

  const { rows } = await pool.query(
    'SELECT * FROM notes WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );

  // Hoist userEmail so the catch block can include it in the failure event
  const userEmail = rows[0]?.created_by ?? userId;
  const content   = generateMarkdown(rows, userEmail);
  const s3Key     = `exports/${userId}/${jobId}.md`;

  await s3.send(new PutObjectCommand({
    Bucket:             EXPORT_BUCKET,
    Key:                s3Key,
    Body:               content,
    ContentType:        'text/markdown; charset=utf-8',
    ContentDisposition: `attachment; filename="notes-export-${jobId.slice(0, 8)}.md"`,
  }));

  await pool.query(
    `UPDATE export_jobs SET status = 'completed', s3_key = $1, completed_at = NOW() WHERE id = $2`,
    [s3Key, jobId]
  );
  console.log(`[${jobId}] completed → s3://${EXPORT_BUCKET}/${s3Key}`);

  await publishEvent({
    event:       'export.completed',
    jobId,
    userId,
    userEmail,
    noteCount:   rows.length,
    completedAt: new Date().toISOString(),
  });
}

// --- Poll loop ---

async function poll() {
  console.log('Polling', QUEUE_URL);

  while (true) {
    const resp = await sqs.send(new ReceiveMessageCommand({
      QueueUrl:            QUEUE_URL,
      MaxNumberOfMessages: 1,
      // Long-polling: blocks up to 20 s before returning empty — far cheaper than tight loops
      WaitTimeSeconds:     20,
      // Hide from other consumers while we process; must finish before this timeout
      VisibilityTimeout:   60,
    }));

    if (!resp.Messages?.length) continue;

    const msg           = resp.Messages[0];
    const { jobId, userId } = JSON.parse(msg.Body);

    try {
      await processJob(jobId, userId);
    } catch (err) {
      console.error(`[${jobId}] failed:`, err.message);
      await pool.query(
        `UPDATE export_jobs SET status = 'failed', error = $1 WHERE id = $2`,
        [err.message.slice(0, 500), jobId]
      );
      await publishEvent({
        event:     'export.failed',
        jobId,
        userId,
        userEmail: userId, // email may not be available if the failure was early
        error:     err.message.slice(0, 200),
        failedAt:  new Date().toISOString(),
      });
    } finally {
      // Always delete after one attempt — a dead-letter queue handles persistent failures in prod
      await sqs.send(new DeleteMessageCommand({
        QueueUrl:      QUEUE_URL,
        ReceiptHandle: msg.ReceiptHandle,
      }));
    }
  }
}

async function start() {
  if (!QUEUE_URL)     throw new Error('SQS_QUEUE_URL is required');
  if (!EXPORT_BUCKET) throw new Error('EXPORT_BUCKET is required');

  pool = await createPool();
  await poll();
}

start().catch((err) => { console.error(err); process.exit(1); });
