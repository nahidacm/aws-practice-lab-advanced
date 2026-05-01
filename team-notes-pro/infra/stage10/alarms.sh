#!/usr/bin/env bash
# Creates all Stage 10 CloudWatch alarms for Team Notes Pro.
# Run once after deploying; safe to re-run (put-metric-alarm is idempotent).
#
# Usage:
#   ALARM_EMAIL=ops@example.com ./alarms.sh
#
# Requires: aws CLI, jq
set -euo pipefail

REGION=${AWS_REGION:-us-east-1}
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ALARM_EMAIL=${ALARM_EMAIL:-}

echo "==> Resolving resource identifiers..."

# ALB resource label (the part after "loadbalancer/" in the ARN, used in CW dimensions)
ALB_ARN=$(aws elbv2 describe-load-balancers \
  --names team-notes-pro-alb \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null \
  || aws elbv2 describe-load-balancers \
      --query 'LoadBalancers[?contains(LoadBalancerName,`team-notes-pro`)].LoadBalancerArn' \
      --output text | head -1)
ALB_LABEL=$(echo "$ALB_ARN" | sed 's|.*:loadbalancer/||')

# SQS queue
SQS_QUEUE_NAME=$(aws sqs get-queue-url \
  --queue-name team-notes-pro-exports \
  --query 'QueueUrl' --output text 2>/dev/null | sed 's|.*/||' || echo "team-notes-pro-exports")

echo "  ALB:    $ALB_LABEL"
echo "  SQS:    $SQS_QUEUE_NAME"

# --------------------------------------------------------------------------
# Optional SNS alarm action — if ALARM_EMAIL is set, route all alarms there
# --------------------------------------------------------------------------
ALARM_ACTIONS=""
if [[ -n "$ALARM_EMAIL" ]]; then
  ALARM_TOPIC_ARN=$(aws sns create-topic \
    --name team-notes-pro-alarms \
    --query 'TopicArn' --output text)
  aws sns subscribe \
    --topic-arn "$ALARM_TOPIC_ARN" \
    --protocol email \
    --notification-endpoint "$ALARM_EMAIL" > /dev/null
  ALARM_ACTIONS="--alarm-actions $ALARM_TOPIC_ARN --ok-actions $ALARM_TOPIC_ARN"
  echo "  Alarm SNS topic: $ALARM_TOPIC_ARN"
  echo "  Confirm subscription in email sent to $ALARM_EMAIL"
fi

# --------------------------------------------------------------------------
# Alarm 1: API 5xx error rate
# Triggers when the ALB sees more than 5 target 5xx responses in 5 minutes.
# Source: AWS/ApplicationELB — built-in, no custom instrumentation needed.
# --------------------------------------------------------------------------
echo "==> Alarm 1: API 5xx errors"
aws cloudwatch put-metric-alarm \
  --alarm-name "TeamNotesPro-API-5xx" \
  --alarm-description "More than 5 API 5xx errors in 5 minutes" \
  --namespace AWS/ApplicationELB \
  --metric-name HTTPCode_Target_5XX_Count \
  --dimensions "Name=LoadBalancer,Value=${ALB_LABEL}" \
  --period 300 \
  --evaluation-periods 1 \
  --threshold 5 \
  --comparison-operator GreaterThanThreshold \
  --statistic Sum \
  --treat-missing-data notBreaching \
  $ALARM_ACTIONS

# --------------------------------------------------------------------------
# Alarm 2: ECS running task count
# Triggers when fewer than 1 API task is running for 1 consecutive minute.
# Source: AWS/ECS — no custom code required.
# --------------------------------------------------------------------------
echo "==> Alarm 2: ECS task health"
aws cloudwatch put-metric-alarm \
  --alarm-name "TeamNotesPro-ECS-TaskHealth" \
  --alarm-description "Fewer than 1 API task running" \
  --namespace AWS/ECS \
  --metric-name RunningTaskCount \
  --dimensions \
      "Name=ClusterName,Value=team-notes-pro" \
      "Name=ServiceName,Value=team-notes-pro-svc" \
  --period 60 \
  --evaluation-periods 1 \
  --threshold 1 \
  --comparison-operator LessThanThreshold \
  --statistic Average \
  --treat-missing-data breaching \
  $ALARM_ACTIONS

# --------------------------------------------------------------------------
# Alarm 3: SQS export queue depth
# Triggers when > 10 unprocessed messages are sitting in the export queue.
# A deep queue means the worker is behind or stopped.
# --------------------------------------------------------------------------
echo "==> Alarm 3: SQS queue depth"
aws cloudwatch put-metric-alarm \
  --alarm-name "TeamNotesPro-SQS-Depth" \
  --alarm-description "Export queue has more than 10 unprocessed messages" \
  --namespace AWS/SQS \
  --metric-name ApproximateNumberOfMessagesVisible \
  --dimensions "Name=QueueName,Value=${SQS_QUEUE_NAME}" \
  --period 300 \
  --evaluation-periods 2 \
  --threshold 10 \
  --comparison-operator GreaterThanThreshold \
  --statistic Maximum \
  --treat-missing-data notBreaching \
  $ALARM_ACTIONS

# --------------------------------------------------------------------------
# Alarm 4: Lambda error rate
# Triggers when the export Lambda has more than 3 errors in 5 minutes.
# Source: AWS/Lambda — built-in.
# --------------------------------------------------------------------------
echo "==> Alarm 4: Lambda errors"
aws cloudwatch put-metric-alarm \
  --alarm-name "TeamNotesPro-Lambda-Errors" \
  --alarm-description "Export Lambda has more than 3 errors in 5 minutes" \
  --namespace AWS/Lambda \
  --metric-name Errors \
  --dimensions "Name=FunctionName,Value=team-notes-pro-export" \
  --period 300 \
  --evaluation-periods 1 \
  --threshold 3 \
  --comparison-operator GreaterThanThreshold \
  --statistic Sum \
  --treat-missing-data notBreaching \
  $ALARM_ACTIONS

# --------------------------------------------------------------------------
# Alarm 5: Custom metric — API errors (from TeamNotesPro/ApiError)
# Triggers when the application emits more than 3 ApiError metrics in 5 min.
# This catches 500s missed by the ALB (e.g. thrown before response is sent).
# --------------------------------------------------------------------------
echo "==> Alarm 5: Custom API error metric"
aws cloudwatch put-metric-alarm \
  --alarm-name "TeamNotesPro-CustomApiError" \
  --alarm-description "Application reported more than 3 ApiError events in 5 minutes" \
  --namespace TeamNotesPro \
  --metric-name ApiError \
  --period 300 \
  --evaluation-periods 1 \
  --threshold 3 \
  --comparison-operator GreaterThanThreshold \
  --statistic Sum \
  --treat-missing-data notBreaching \
  $ALARM_ACTIONS

echo ""
echo "==> All alarms created. View at:"
echo "    https://console.aws.amazon.com/cloudwatch/home?region=${REGION}#alarmsV2:"
