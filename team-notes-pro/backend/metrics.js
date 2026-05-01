// Custom CloudWatch metrics for Stage 10.
//
// Metric strategy — only track signals that answer real questions:
//
//   TeamNotesPro/CacheHit    — was GET /api/notes served from Redis?
//   TeamNotesPro/CacheMiss   — did it fall through to the DB?
//   TeamNotesPro/ExportStarted — how many exports are users requesting?
//   TeamNotesPro/ApiError    — unhandled 500s in the API
//
// All metrics live in the custom namespace "TeamNotesPro" so they're easy to
// find in the console and don't get lost among AWS built-in metrics.
//
// Set CLOUDWATCH_METRICS=true in ECS task env vars to enable.
// When unset (local dev), putMetric is a silent no-op so no code paths need
// to guard against it.

const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

const NAMESPACE = 'TeamNotesPro';
const REGION    = process.env.AWS_REGION || 'us-east-1';

const cw = process.env.CLOUDWATCH_METRICS === 'true'
  ? new CloudWatchClient({ region: REGION })
  : null;

async function putMetric(name, value = 1, unit = 'Count') {
  if (!cw) return;
  try {
    await cw.send(new PutMetricDataCommand({
      Namespace:  NAMESPACE,
      MetricData: [{
        MetricName: name,
        Value:      value,
        Unit:       unit,
        Timestamp:  new Date(),
      }],
    }));
  } catch (err) {
    // Non-fatal — a metrics failure must never break an API request
    console.error(JSON.stringify({ level: 'error', event: 'metric.failed', name, error: err.message }));
  }
}

module.exports = { putMetric };
