// Structured JSON logger for Stage 10.
//
// All output goes to stdout. ECS and Lambda both forward stdout to CloudWatch Logs.
// JSON lines are queryable in CloudWatch Logs Insights:
//
//   fields @timestamp, level, event, route, statusCode, ms
//   | filter level = "error"
//   | sort @timestamp desc
//
// Using plain console.log keeps this dependency-free and works identically in
// local dev, ECS, and Lambda.

function log(level, event, data = {}) {
  console.log(JSON.stringify({
    level,
    event,
    ts: new Date().toISOString(),
    ...data,
  }));
}

const logger = {
  info:  (event, data) => log('info',  event, data),
  warn:  (event, data) => log('warn',  event, data),
  error: (event, data) => log('error', event, data),
};

module.exports = logger;
