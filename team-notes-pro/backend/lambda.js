// Stage 8 — Step Functions export task handler.
//
// A single Lambda function dispatched by the "action" field in the event.
// Each action maps to one state in the export state machine, so there is
// one function to deploy, one set of logs to tail, one IAM role to configure.
//
// Actions:
//   validate      — mark job as 'processing', guard against double-starts
//   fetchNotes    — query notes for the user, return rows + metadata
//   processExport — generate markdown, upload to S3
//   markComplete  — update DB, publish SNS success event
//   markFailed    — update DB with error, publish SNS failure event

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { SNSClient, PublishCommand }  = require('@aws-sdk/client-sns');
const { createPool }                 = require('./db');

const REGION        = process.env.AWS_REGION || 'us-east-1';
const EXPORT_BUCKET = process.env.EXPORT_BUCKET;

const s3  = new S3Client({ region: REGION });
const sns = process.env.SNS_TOPIC_ARN ? new SNSClient({ region: REGION }) : null;

// Pool is reused across warm Lambda invocations
let pool;
async function getPool() {
  if (!pool) pool = await createPool();
  return pool;
}

// --- Markdown generator ---

function generateMarkdown(notes, userEmail) {
  const header = [
    '# Team Notes Pro Export',
    `User: ${userEmail}`,
    `Exported: ${new Date().toISOString()}`,
    `Notes: ${notes.length}`,
    '',
  ];
  const body = notes.flatMap((n) => [
    '---', '',
    `## ${n.title}`,
    `*${new Date(n.created_at).toLocaleDateString('en-US', { dateStyle: 'medium' })}*`,
    '', n.content, '',
  ]);
  return [...header, ...body].join('\n');
}

// --- SNS helper ---

async function publishEvent(payload) {
  if (!sns) return;
  try {
    await sns.send(new PublishCommand({
      TopicArn: process.env.SNS_TOPIC_ARN,
      Subject:  payload.event === 'export.completed'
        ? `Export ready — ${payload.noteCount} note${payload.noteCount !== 1 ? 's' : ''}`
        : 'Export failed',
      Message:  JSON.stringify(payload, null, 2),
      MessageAttributes: {
        event: { DataType: 'String', StringValue: payload.event },
      },
    }));
  } catch (err) {
    console.error('SNS publish failed:', err.message);
  }
}

// --- Action handlers ---

// validate: guard against double-starts; mark job processing
async function validate({ jobId, userId }) {
  const db = await getPool();
  const { rowCount } = await db.query(
    `UPDATE export_jobs SET status = 'processing'
     WHERE id = $1 AND user_id = $2 AND status = 'queued'`,
    [jobId, userId]
  );
  if (rowCount === 0) throw new Error(`Job ${jobId} not found or already processing`);
  return { ok: true };
}

// fetchNotes: returns rows through Step Functions state so processExport
// doesn't need a second DB round-trip. Fine for small note sets (< 256 KB state limit).
async function fetchNotes({ userId }) {
  const db = await getPool();
  const { rows } = await db.query(
    'SELECT id, title, content, created_by, created_at FROM notes WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return {
    notes:     rows,
    userEmail: rows[0]?.created_by ?? userId,
    noteCount: rows.length,
  };
}

// processExport: generate markdown + upload — no DB call needed
async function processExport({ jobId, userId, notes, userEmail }) {
  const content = generateMarkdown(notes, userEmail);
  const s3Key   = `exports/${userId}/${jobId}.md`;

  await s3.send(new PutObjectCommand({
    Bucket:             EXPORT_BUCKET,
    Key:                s3Key,
    Body:               content,
    ContentType:        'text/markdown; charset=utf-8',
    ContentDisposition: `attachment; filename="notes-export-${jobId.slice(0, 8)}.md"`,
  }));

  return { s3Key };
}

// markComplete: write final DB state, fire SNS
async function markComplete({ jobId, userId, s3Key, userEmail, noteCount }) {
  const db = await getPool();
  await db.query(
    `UPDATE export_jobs SET status = 'completed', s3_key = $1, completed_at = NOW() WHERE id = $2`,
    [s3Key, jobId]
  );
  await publishEvent({
    event: 'export.completed', jobId, userId,
    userEmail, noteCount, completedAt: new Date().toISOString(),
  });
  return { status: 'completed' };
}

// markFailed: called by Step Functions Catch on any state failure
// error is the Step Functions error shape: { Error, Cause }
async function markFailed({ jobId, userId, error }) {
  const db  = await getPool();
  const msg = error?.Cause ?? error?.Error ?? JSON.stringify(error);
  await db.query(
    `UPDATE export_jobs SET status = 'failed', error = $1 WHERE id = $2`,
    [msg.slice(0, 500), jobId]
  );
  await publishEvent({
    event: 'export.failed', jobId, userId,
    error: msg.slice(0, 200), failedAt: new Date().toISOString(),
  });
  return { status: 'failed' };
}

// --- Stage 9: Scheduled job handlers ---
//
// Both are invoked directly by EventBridge on a cron schedule.
// EventBridge passes the event payload defined in the rule target Input field:
//   { "action": "cleanup" }  or  { "action": "weeklySummary" }

// cleanup: delete export_jobs rows (and their S3 files) older than 7 days.
// The S3 bucket already has a 7-day lifecycle rule (Stage 5), so this is a
// belt-and-suspenders DB cleanup. Deleting from DB is necessary because the
// lifecycle rule only removes S3 objects — the DB rows stay forever otherwise.
async function cleanup() {
  const db = await getPool();

  // Collect S3 keys for completed jobs about to be deleted so we can remove the files too.
  // (Failed/queued jobs have no s3_key so they're just row-deleted.)
  const { rows } = await db.query(`
    SELECT id, s3_key
    FROM   export_jobs
    WHERE  requested_at < NOW() - INTERVAL '7 days'
    AND    s3_key IS NOT NULL
  `);

  let deletedFiles = 0;
  for (const job of rows) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: EXPORT_BUCKET, Key: job.s3_key }));
      deletedFiles++;
    } catch (err) {
      // Log and continue — a missing S3 object shouldn't block the DB cleanup
      console.error(`cleanup: failed to delete ${job.s3_key}:`, err.message);
    }
  }

  const { rowCount } = await db.query(
    `DELETE FROM export_jobs WHERE requested_at < NOW() - INTERVAL '7 days'`
  );

  console.log(`cleanup: removed ${rowCount} job rows, ${deletedFiles} S3 files`);
  return { deletedJobs: rowCount, deletedFiles };
}

// weeklySummary: count notes across all users, publish a summary to SNS.
async function weeklySummary() {
  const db = await getPool();

  const { rows: [stats] } = await db.query(`
    SELECT
      COUNT(*)                                                        AS total_notes,
      COUNT(DISTINCT user_id)                                         AS total_users,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS new_this_week
    FROM notes
  `);

  const summary = {
    event:        'weekly.summary',
    totalNotes:   parseInt(stats.total_notes,   10),
    totalUsers:   parseInt(stats.total_users,   10),
    newThisWeek:  parseInt(stats.new_this_week, 10),
    generatedAt:  new Date().toISOString(),
  };

  console.log('weeklySummary:', summary);

  if (sns) {
    await sns.send(new PublishCommand({
      TopicArn:  process.env.SNS_TOPIC_ARN,
      Subject:   `Weekly Summary — ${summary.newThisWeek} new note${summary.newThisWeek !== 1 ? 's' : ''} this week`,
      Message:   JSON.stringify(summary, null, 2),
      MessageAttributes: {
        event: { DataType: 'String', StringValue: 'weekly.summary' },
      },
    }));
  }

  return summary;
}

// --- Dispatcher ---

const ACTIONS = { validate, fetchNotes, processExport, markComplete, markFailed, cleanup, weeklySummary };

exports.handler = async (event) => {
  const { action, ...params } = event;
  const fn = ACTIONS[action];
  if (!fn) throw new Error(`Unknown action: ${action}`);
  // jobId is present for export actions, absent for scheduled actions
  console.log(`[${params.jobId ?? 'scheduler'}] action=${action}`);
  return fn(params);
};
