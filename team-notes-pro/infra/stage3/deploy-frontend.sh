#!/usr/bin/env bash
# Builds the React frontend and deploys it to S3, then invalidates CloudFront.
# Usage:
#   S3_BUCKET=notes-frontend-prod \
#   CLOUDFRONT_DISTRIBUTION_ID=EXXXXXXXXXX \
#   VITE_API_URL=https://api.notes.yourdomain.com \
#   VITE_COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX \
#   VITE_COGNITO_CLIENT_ID=XXXXXXXXXXXXXXXXXXXXXXXXXX \
#   ./deploy-frontend.sh
set -euo pipefail

: "${S3_BUCKET:?S3_BUCKET is required}"
: "${CLOUDFRONT_DISTRIBUTION_ID:?CLOUDFRONT_DISTRIBUTION_ID is required}"
: "${VITE_API_URL:?VITE_API_URL is required}"
: "${VITE_COGNITO_USER_POOL_ID:?VITE_COGNITO_USER_POOL_ID is required}"
: "${VITE_COGNITO_CLIENT_ID:?VITE_COGNITO_CLIENT_ID is required}"

FRONTEND_DIR="$(cd "$(dirname "$0")/../../frontend" && pwd)"

echo "==> Building frontend (VITE_API_URL=$VITE_API_URL)..."
cd "$FRONTEND_DIR"
VITE_API_URL="$VITE_API_URL" \
VITE_COGNITO_USER_POOL_ID="$VITE_COGNITO_USER_POOL_ID" \
VITE_COGNITO_CLIENT_ID="$VITE_COGNITO_CLIENT_ID" \
npm run build

echo "==> Uploading hashed assets to s3://$S3_BUCKET ..."
# Long-lived cache for fingerprinted assets (JS/CSS have content hashes in filenames)
aws s3 sync dist/ "s3://$S3_BUCKET" \
  --delete \
  --exclude "index.html" \
  --cache-control "public,max-age=31536000,immutable"

echo "==> Uploading index.html (no-cache)..."
# index.html must never be cached — it's the entry point that references the hashed assets
aws s3 cp dist/index.html "s3://$S3_BUCKET/index.html" \
  --cache-control "no-cache,no-store,must-revalidate" \
  --content-type "text/html"

echo "==> Invalidating CloudFront cache..."
aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --paths "/*" \
  --query 'Invalidation.Id' \
  --output text

echo "==> Done! Frontend deployed to s3://$S3_BUCKET"
echo "    CloudFront will propagate within ~1 minute."
