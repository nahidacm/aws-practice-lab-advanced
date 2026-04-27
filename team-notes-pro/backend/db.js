const { Pool } = require('pg');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

// Local dev:  set DATABASE_URL and this function skips Secrets Manager entirely.
// Production: set DB_SECRET_ARN + AWS_REGION and credentials are fetched at startup.
async function createPool() {
  if (process.env.DATABASE_URL) {
    return new Pool({ connectionString: process.env.DATABASE_URL });
  }

  const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const { SecretString } = await sm.send(
    new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN })
  );
  const { host, port, dbname, username, password } = JSON.parse(SecretString);

  return new Pool({
    host,
    port,
    database: dbname,
    user: username,
    password,
    ssl: { rejectUnauthorized: false }, // RDS requires SSL
    max: 10,
    idleTimeoutMillis: 30000,
  });
}

module.exports = { createPool };
