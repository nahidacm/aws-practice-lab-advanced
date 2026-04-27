# Deployment Guide — Stage 1

## Local Development

### Option A: Run services separately (recommended for active dev)

```bash
# Terminal 1 — backend (nodemon, auto-restarts on change)
cd backend
npm install
npm run dev        # http://localhost:3000

# Terminal 2 — frontend (Vite HMR, proxies /api → :3000)
cd frontend
npm install
npm run dev        # http://localhost:5173
```

### Option B: Docker Compose (mirrors production)

```bash
docker compose up --build
# App available at http://localhost:3000
```

---

## AWS Deployment

### Prerequisites

- AWS CLI configured (`aws configure`)
- Docker installed
- An AWS account with permissions for ECR, ECS, EC2 (VPC/ALB), and IAM

---

### Step 1 — VPC

Create a VPC with public subnets in at least 2 Availability Zones (required by the ALB).

```bash
# Easiest: use the AWS console VPC wizard
# Settings:
#   - 1 VPC
#   - 2 public subnets (e.g. us-east-1a, us-east-1b)
#   - No private subnets needed for Stage 1
#   - No NAT gateway needed for Stage 1
```

Note the **VPC ID** and both **Subnet IDs** — you'll need them below.

---

### Step 2 — Security Groups

Create two security groups in your VPC.

**ALB security group** (`sg-alb`):
| Direction | Protocol | Port | Source |
|-----------|----------|------|--------|
| Inbound   | HTTP     | 80   | 0.0.0.0/0 |
| Outbound  | All      | All  | 0.0.0.0/0 |

**App security group** (`sg-app`):
| Direction | Protocol | Port | Source |
|-----------|----------|------|--------|
| Inbound   | TCP      | 3000 | sg-alb |
| Outbound  | All      | All  | 0.0.0.0/0 |

---

### Step 3 — ECR (Container Registry)

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_URI=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/team-notes-pro

# Create the repository
aws ecr create-repository \
  --repository-name team-notes-pro \
  --region $AWS_REGION

# Authenticate Docker with ECR
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# Build, tag, and push
docker build -t team-notes-pro:stage1 .
docker tag team-notes-pro:stage1 $ECR_URI:stage1
docker push $ECR_URI:stage1
```

---

### Step 4 — ECS Cluster

```bash
aws ecs create-cluster \
  --cluster-name team-notes-pro \
  --region $AWS_REGION
```

---

### Step 5 — IAM Task Execution Role

ECS needs this role to pull the image from ECR and write logs to CloudWatch.

```bash
# Create the role
aws iam create-role \
  --role-name ecsTaskExecutionRole \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "ecs-tasks.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }]
  }'

# Attach the AWS managed policy
aws iam attach-role-policy \
  --role-name ecsTaskExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
```

---

### Step 6 — CloudWatch Log Group

```bash
aws logs create-log-group \
  --log-group-name /ecs/team-notes-pro \
  --region $AWS_REGION
```

---

### Step 7 — ECS Task Definition

Save this as `task-definition.json`, replacing `<AWS_ACCOUNT_ID>` and `<AWS_REGION>`:

```json
{
  "family": "team-notes-pro",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::<AWS_ACCOUNT_ID>:role/ecsTaskExecutionRole",
  "containerDefinitions": [
    {
      "name": "app",
      "image": "<AWS_ACCOUNT_ID>.dkr.ecr.<AWS_REGION>.amazonaws.com/team-notes-pro:stage1",
      "portMappings": [{ "containerPort": 3000, "protocol": "tcp" }],
      "environment": [
        { "name": "PORT", "value": "3000" },
        { "name": "NODE_ENV", "value": "production" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/team-notes-pro",
          "awslogs-region": "<AWS_REGION>",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "wget -qO- http://localhost:3000/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 10
      }
    }
  ]
}
```

Register it:

```bash
aws ecs register-task-definition \
  --cli-input-json file://task-definition.json \
  --region $AWS_REGION
```

---

### Step 8 — Application Load Balancer

```bash
# Replace with your actual subnet IDs and security group ID
export SUBNET_1=subnet-xxxxxxxx
export SUBNET_2=subnet-yyyyyyyy
export SG_ALB=sg-xxxxxxxx

# Create the ALB
ALB_ARN=$(aws elbv2 create-load-balancer \
  --name team-notes-pro-alb \
  --subnets $SUBNET_1 $SUBNET_2 \
  --security-groups $SG_ALB \
  --query 'LoadBalancers[0].LoadBalancerArn' \
  --output text)

# Create the target group (health check points to /health)
export VPC_ID=vpc-xxxxxxxx

TG_ARN=$(aws elbv2 create-target-group \
  --name team-notes-pro-tg \
  --protocol HTTP \
  --port 3000 \
  --vpc-id $VPC_ID \
  --target-type ip \
  --health-check-path /health \
  --health-check-interval-seconds 30 \
  --healthy-threshold-count 2 \
  --query 'TargetGroups[0].TargetGroupArn' \
  --output text)

# Create an HTTP listener
aws elbv2 create-listener \
  --load-balancer-arn $ALB_ARN \
  --protocol HTTP \
  --port 80 \
  --default-actions Type=forward,TargetGroupArn=$TG_ARN
```

---

### Step 9 — ECS Service

```bash
export SG_APP=sg-yyyyyyyy

aws ecs create-service \
  --cluster team-notes-pro \
  --service-name team-notes-pro-svc \
  --task-definition team-notes-pro \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={
    subnets=[$SUBNET_1,$SUBNET_2],
    securityGroups=[$SG_APP],
    assignPublicIp=ENABLED
  }" \
  --load-balancers "targetGroupArn=$TG_ARN,containerName=app,containerPort=3000" \
  --region $AWS_REGION
```

---

### Step 10 — Verify

```bash
# Get the ALB DNS name
aws elbv2 describe-load-balancers \
  --load-balancer-arns $ALB_ARN \
  --query 'LoadBalancers[0].DNSName' \
  --output text
```

Open the DNS name in a browser — Team Notes Pro should load.

Check the health endpoint:
```bash
curl http://<ALB_DNS_NAME>/health
# {"status":"ok"}
```

Check ECS service events if the task fails to start:
```bash
aws ecs describe-services \
  --cluster team-notes-pro \
  --services team-notes-pro-svc \
  --query 'services[0].events[:5]'
```

---

### Deploying a New Image

```bash
# Rebuild and push
docker build -t team-notes-pro:stage1 .
docker tag team-notes-pro:stage1 $ECR_URI:stage1
docker push $ECR_URI:stage1

# Force a new deployment (ECS pulls the latest image)
aws ecs update-service \
  --cluster team-notes-pro \
  --service team-notes-pro-svc \
  --force-new-deployment \
  --region $AWS_REGION
```

---

### Teardown

```bash
# Scale down service
aws ecs update-service --cluster team-notes-pro --service team-notes-pro-svc --desired-count 0

# Delete service
aws ecs delete-service --cluster team-notes-pro --service team-notes-pro-svc --force

# Delete cluster
aws ecs delete-cluster --cluster team-notes-pro

# Delete ALB and target group
aws elbv2 delete-load-balancer --load-balancer-arn $ALB_ARN
aws elbv2 delete-target-group --target-group-arn $TG_ARN

# Delete ECR repository
aws ecr delete-repository --repository-name team-notes-pro --force
```
