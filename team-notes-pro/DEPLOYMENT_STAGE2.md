# Deployment Guide — Stage 2

Adds Amazon RDS for PostgreSQL as persistent storage and AWS Secrets Manager to supply
database credentials to the ECS task without hardcoding them.

---

## Local Development

### Option A: Docker Compose (easiest)

Spins up the app and a local Postgres container together.

```bash
docker compose up --build
# App: http://localhost:3000
# Postgres: localhost:5432 (user: postgres / pass: postgres / db: teamnotes)
```

### Option B: Run services separately

```bash
# Start a local Postgres (one-liner)
docker run -d --name pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=teamnotes \
  -p 5432:5432 \
  postgres:16-alpine

# Terminal 1 — backend
cd backend
cp ../.env.example .env          # DATABASE_URL is already set
npm install
npm run dev                      # http://localhost:3000

# Terminal 2 — frontend (Vite proxies /api → :3000)
cd frontend
npm run dev                      # http://localhost:5173
```

---

## AWS Deployment

### New components in this stage

| Component | Purpose |
|-----------|---------|
| RDS PostgreSQL | Persistent note storage |
| Secrets Manager secret | DB credentials stored and rotated outside the app |
| ECS Task Role | Grants the app permission to read the secret |
| Security group rule | Allows ECS tasks to reach RDS on port 5432 |

### Prerequisites

Complete all steps from Stage 1 (VPC, ECR, ECS cluster, ALB) before proceeding.

---

### Step 1 — Security Groups

You need a new security group for RDS, and a rule added to the existing app security group.

**RDS security group** (`sg-rds`):
| Direction | Protocol | Port | Source |
|-----------|----------|------|--------|
| Inbound   | TCP      | 5432 | `sg-app` (the ECS tasks security group) |
| Outbound  | All      | All  | 0.0.0.0/0 |

> **Why**: RDS lives in private subnets with no internet access. The only inbound rule is from
> `sg-app`, so only your ECS tasks can connect. Nothing else — not even your laptop — can reach
> the database directly. This is the standard pattern for ECS-to-RDS traffic.

```bash
export AWS_REGION=us-east-1
export VPC_ID=vpc-xxxxxxxx
export SG_APP=sg-xxxxxxxx       # ECS tasks security group from Stage 1

# Create the RDS security group
SG_RDS=$(aws ec2 create-security-group \
  --group-name sg-rds \
  --description "RDS - allow ECS tasks on 5432" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

# Allow ECS → RDS on port 5432
aws ec2 authorize-security-group-ingress \
  --group-id $SG_RDS \
  --protocol tcp \
  --port 5432 \
  --source-group $SG_APP
```

---

### Step 2 — RDS Subnet Group

RDS needs to know which private subnets it can use.

```bash
export PRIVATE_SUBNET_1=subnet-xxxxxxxx
export PRIVATE_SUBNET_2=subnet-yyyyyyyy

aws rds create-db-subnet-group \
  --db-subnet-group-name team-notes-pro-subnet-group \
  --db-subnet-group-description "Team Notes Pro RDS subnets" \
  --subnet-ids $PRIVATE_SUBNET_1 $PRIVATE_SUBNET_2
```

---

### Step 3 — RDS PostgreSQL Instance

```bash
# Pick a strong password — you'll store it in Secrets Manager, not in .env
export DB_PASSWORD="YourStrongPasswordHere123!"

aws rds create-db-instance \
  --db-instance-identifier team-notes-pro-db \
  --db-instance-class db.t3.micro \
  --engine postgres \
  --engine-version 16 \
  --master-username postgres \
  --master-user-password $DB_PASSWORD \
  --allocated-storage 20 \
  --db-name teamnotes \
  --db-subnet-group-name team-notes-pro-subnet-group \
  --vpc-security-group-ids $SG_RDS \
  --no-publicly-accessible \
  --backup-retention-period 1 \
  --region $AWS_REGION

# Wait for the instance to become available (~5 minutes)
aws rds wait db-instance-available \
  --db-instance-identifier team-notes-pro-db

# Get the endpoint hostname
DB_HOST=$(aws rds describe-db-instances \
  --db-instance-identifier team-notes-pro-db \
  --query 'DBInstances[0].Endpoint.Address' \
  --output text)

echo "RDS host: $DB_HOST"
```

> **Cost note**: `db.t3.micro` is included in the AWS free tier for 12 months (750 hours/month).
> Delete the instance when done to avoid charges after the free tier period.

---

### Step 4 — Secrets Manager

Store the DB credentials as a JSON secret in the format that the app expects.

```bash
aws secretsmanager create-secret \
  --name team-notes-pro/db \
  --description "Team Notes Pro RDS credentials" \
  --secret-string "{
    \"username\": \"postgres\",
    \"password\": \"$DB_PASSWORD\",
    \"host\": \"$DB_HOST\",
    \"port\": 5432,
    \"dbname\": \"teamnotes\"
  }" \
  --region $AWS_REGION

# Save the ARN — you'll need it in the task definition
SECRET_ARN=$(aws secretsmanager describe-secret \
  --secret-id team-notes-pro/db \
  --query 'ARN' --output text)

echo "Secret ARN: $SECRET_ARN"
```

---

### Step 5 — IAM Task Role

The **task execution role** (Stage 1) pulls images and writes logs.
The **task role** is the identity the *application code* runs as — it needs permission to call `secretsmanager:GetSecretValue`.

```bash
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Create the task role
aws iam create-role \
  --role-name ecsTaskRole-team-notes-pro \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "ecs-tasks.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }]
  }'

# Allow it to read only this specific secret
aws iam put-role-policy \
  --role-name ecsTaskRole-team-notes-pro \
  --policy-name ReadDBSecret \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": \"secretsmanager:GetSecretValue\",
      \"Resource\": \"$SECRET_ARN\"
    }]
  }"
```

---

### Step 6 — Updated Task Definition

Save as `task-definition-stage2.json`, replacing the placeholder values:

```json
{
  "family": "team-notes-pro",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/ecsTaskRole-team-notes-pro",
  "containerDefinitions": [
    {
      "name": "app",
      "image": "<ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/team-notes-pro:stage2",
      "portMappings": [{ "containerPort": 3000, "protocol": "tcp" }],
      "environment": [
        { "name": "PORT",       "value": "3000" },
        { "name": "NODE_ENV",   "value": "production" },
        { "name": "AWS_REGION", "value": "<REGION>" },
        { "name": "DB_SECRET_ARN", "value": "<SECRET_ARN>" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/team-notes-pro",
          "awslogs-region": "<REGION>",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "wget -qO- http://localhost:3000/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 15
      }
    }
  ]
}
```

Register it:

```bash
aws ecs register-task-definition \
  --cli-input-json file://task-definition-stage2.json \
  --region $AWS_REGION
```

---

### Step 7 — Build and Push Updated Image

```bash
export ECR_URI=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/team-notes-pro

aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

docker build -t team-notes-pro:stage2 .
docker tag team-notes-pro:stage2 $ECR_URI:stage2
docker push $ECR_URI:stage2
```

---

### Step 8 — Deploy Updated ECS Service

```bash
aws ecs update-service \
  --cluster team-notes-pro \
  --service team-notes-pro-svc \
  --task-definition team-notes-pro \
  --force-new-deployment \
  --region $AWS_REGION
```

ECS will drain the old task and start a new one. On startup, the app:
1. Reads `DB_SECRET_ARN` from the environment
2. Calls Secrets Manager to get credentials
3. Opens a pg connection pool
4. Runs `CREATE TABLE IF NOT EXISTS notes ...`
5. Starts listening on port 3000

---

### Step 9 — Verify

```bash
# Get ALB DNS name
ALB_DNS=$(aws elbv2 describe-load-balancers \
  --names team-notes-pro-alb \
  --query 'LoadBalancers[0].DNSName' \
  --output text)

curl http://$ALB_DNS/health
# {"status":"ok"}

curl -X POST http://$ALB_DNS/api/notes \
  -H 'Content-Type: application/json' \
  -d '{"title":"Persisted","content":"This note survives a container restart.","createdBy":"You"}'
```

Restart the ECS service (`--force-new-deployment`) and confirm the note is still there after the
new task starts — that proves data is in RDS, not in memory.

---

### Teardown (Stage 2 additions only)

```bash
# Delete RDS instance (add --skip-final-snapshot to skip backup)
aws rds delete-db-instance \
  --db-instance-identifier team-notes-pro-db \
  --skip-final-snapshot

aws rds delete-db-subnet-group \
  --db-subnet-group-name team-notes-pro-subnet-group

# Delete secret
aws secretsmanager delete-secret \
  --secret-id team-notes-pro/db \
  --force-delete-without-recovery

# Delete task role
aws iam delete-role-policy \
  --role-name ecsTaskRole-team-notes-pro \
  --policy-name ReadDBSecret

aws iam delete-role --role-name ecsTaskRole-team-notes-pro

# Delete RDS security group (after RDS is fully deleted)
aws ec2 delete-security-group --group-id $SG_RDS
```
