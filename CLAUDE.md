# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an AWS learning lab for building **Team Notes Pro** — a small internal notes application that grows incrementally across 13 stages, each introducing a new AWS service or pattern. The focus is on AWS architecture and operations, not application complexity.

**Prerequisite:** Complete the original `aws-practice-lab` through the CloudWatch stage.

## Core Principles

- Keep the application **intentionally small** — add only enough app code to justify the AWS service
- Prefer boring, readable code over clever abstractions
- Output runnable code, not pseudo-code
- Use managed AWS services where they teach a real platform concept

## Stage Progression

Each stage builds on the previous. The app starts as a simple notes CRUD app and adds AWS capabilities:

| Stage | AWS Services | App Change |
|-------|-------------|------------|
| 1 | VPC, ECS Fargate, ALB, ECR | Containerized app with `/health` endpoint |
| 2 | RDS PostgreSQL, Secrets Manager | Persistent notes storage, DB migrations |
| 3 | S3, CloudFront, Route 53, ACM | Static frontend, custom domain |
| 4 | Cognito | User auth, per-user notes |
| 5 | SQS, ECS worker | Async note export jobs |
| 6 | ElastiCache (Redis) | Cache notes list, cache invalidation |
| 7 | SNS | Export completion notifications |
| 8 | Step Functions | Multi-step export workflow orchestration |
| 9 | EventBridge | Nightly cleanup, weekly summary schedules |
| 10 | CloudWatch, X-Ray, Alarms | Structured logs, metrics, tracing |
| 11 | WAF | Rate-based rules, managed protections |
| 12 | CodePipeline, CodeBuild | Automated image build and ECS deploy |
| 13 | AWS CDK or Terraform | Full infrastructure as code |

## Prompt Template

Every AI prompt for a stage should include these global rules:

```
- Keep the application intentionally small
- Prefer a simple monorepo or clearly separated frontend/backend folders
- Favor readable code over layered abstractions
- Output runnable code, not pseudo-code
- Explain each AWS service briefly and why it exists
- Include a Mermaid architecture diagram
- Include a short deployment guide
- Keep costs in mind and call out expensive services
- Prefer managed AWS services unless a lower-level setup is the point of the stage
- Show environment variables and secrets clearly
```

## Notes Data Model (Stage 2+)

```
id, title, content, created_at, created_by
```

## Recommended Build Order

1. Stages 1–4: proper web app platform
2. Stages 5–7: async and event-driven patterns
3. Stages 8–10: orchestration and observability
4. Stages 11–13: security, CI/CD, and infrastructure as code
