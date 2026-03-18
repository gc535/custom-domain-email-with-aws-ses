#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMAIL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

echo "Deploying custom domain email (SES receive → S3 → forward to your inbox)..."

# Source root config (.env) so one place drives backend and app
if [ -f "$EMAIL_ROOT/.env" ]; then
  set -a
  source "$EMAIL_ROOT/.env"
  set +a
fi
# Optional: backend-specific overrides
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

if ! command -v sam >/dev/null 2>&1; then
  echo "Error: AWS SAM CLI is required" >&2
  echo "Install: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html" >&2
  exit 1
fi
if ! command -v aws >/dev/null 2>&1; then
  echo "Error: AWS CLI is required for probing shared resources" >&2
  exit 1
fi

# Project name (prefix for resource names)
PROJECT_NAME_DEFAULT="${PROJECT_NAME:-custom-domain-email}"
read -rp "Project name [${PROJECT_NAME_DEFAULT}]: " PROJECT_NAME_INPUT
PROJECT_NAME_RAW="${PROJECT_NAME_INPUT:-$PROJECT_NAME_DEFAULT}"
# S3 bucket names: lowercase, hyphens only; sanitize for AWS
PROJECT_NAME=$(echo "$PROJECT_NAME_RAW" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//' | sed 's/--*/-/g')
[ -z "$PROJECT_NAME" ] && PROJECT_NAME="custom-domain-email"

# Email to forward received mail to (set in .env)
echo ""
read -rp "Email to forward [${INBOX_EMAIL:-}]: " INBOX_EMAIL_INPUT
INBOX_EMAIL="${INBOX_EMAIL_INPUT:-$INBOX_EMAIL}"
if [ -z "$INBOX_EMAIL" ]; then
  echo "Error: Email to forward is required. Set INBOX_EMAIL in .env or enter when prompted." >&2
  exit 1
fi

# Domain name (set in .env)
read -rp "Domain name [${DOMAIN_NAME:-}]: " DOMAIN_NAME_INPUT
DOMAIN_NAME="${DOMAIN_NAME_INPUT:-$DOMAIN_NAME}"
if [ -z "$DOMAIN_NAME" ]; then
  echo "Error: Domain name is required. Set DOMAIN_NAME in .env or enter when prompted." >&2
  exit 1
fi

# Optional: Route 53 hosted zone ID (set in .env)
echo ""
echo "Hosted Zone ID (optional):"
echo "  If provided: stack creates SES domain + DKIM records in Route 53 → domain verifies automatically."
echo "  If not provided: you must verify the domain in the SES console and add DKIM records yourself."
read -rp "Hosted Zone ID [${HOSTED_ZONE_ID:-}] (or type none to skip): " HOSTED_ZONE_ID_INPUT
HOSTED_ZONE_ID="${HOSTED_ZONE_ID_INPUT:-$HOSTED_ZONE_ID}"
[ "$HOSTED_ZONE_ID" = "none" ] || [ "$HOSTED_ZONE_ID" = "n" ] && HOSTED_ZONE_ID=""

# Region (default us-east-1; must support SES email receiving)
REGION_DEFAULT="${AWS_REGION:-us-east-1}"
read -rp "Region [${REGION_DEFAULT}]: " REGION_INPUT
REGION="${REGION_INPUT:-$REGION_DEFAULT}"

STACK_NAME="${PROJECT_NAME}"

# Decide whether this stack owns the shared resources.
# We first check if the CloudFormation stack already contains the shared bucket resource.
# If it does, keep CreateSharedResources=true even if the bucket already exists.
# This prevents the template from switching to ReceiptRuleAdditionalDeploy and trying to recreate
# a receipt rule that already exists for the first domain.
AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
SHARED_BUCKET_NAME="custom-domain-email-inbound-${AWS_ACCOUNT_ID}"

STACK_HAS_SHARED_BUCKET="false"
if aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query 'Stacks[0].StackStatus' --output text >/dev/null 2>&1; then
  # Check if the stack already contains the shared bucket logical resource.
  # Using a single AWS query string (no escaped quotes) to avoid shell parsing issues.
  HAS_BUCKET_LEN="$(aws cloudformation describe-stack-resources \
    --stack-name "$STACK_NAME" \
    --query "length(StackResources[?LogicalResourceId=='InboundEmailBucket'])" \
    --output text 2>/dev/null || echo 0)"
  if [ "${HAS_BUCKET_LEN}" != "0" ]; then
    STACK_HAS_SHARED_BUCKET="true"
  fi
fi

if [ "$STACK_HAS_SHARED_BUCKET" = "true" ]; then
  CREATE_SHARED_RESOURCES="true"
else
  # Stack doesn't yet have shared resources; fall back to bucket probe.
  if [ -z "$AWS_ACCOUNT_ID" ] || [ "$SHARED_BUCKET_NAME" = "custom-domain-email-inbound-" ]; then
    CREATE_SHARED_RESOURCES="true"
  elif aws s3api head-bucket --bucket "$SHARED_BUCKET_NAME" 2>/dev/null; then
    CREATE_SHARED_RESOURCES="false"
  else
    CREATE_SHARED_RESOURCES="true"
  fi
fi

echo ""
echo "Using: Stack=$STACK_NAME, Domain=$DOMAIN_NAME, Inbox=$INBOX_EMAIL, Region=$REGION"
[ -n "$HOSTED_ZONE_ID" ] && echo "SES domain verification: enabled (DKIM records will be created in Route 53)"
[ "$CREATE_SHARED_RESOURCES" = "true" ] && echo "Shared resources: will create bucket and rule set (first domain)"
[ "$CREATE_SHARED_RESOURCES" = "false" ] && echo "Shared resources: using existing bucket and rule set (additional domain)"
echo ""

echo "Installing dependencies..."
npm install --production --silent

echo "Building..."
sam build

echo "Deploying..."
sam deploy \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --region "$REGION" \
  --parameter-overrides \
    ProjectName="$PROJECT_NAME" \
    DomainName="$DOMAIN_NAME" \
    InboxEmail="$INBOX_EMAIL" \
    Region="$REGION" \
    HostedZoneId="${HOSTED_ZONE_ID:-}" \
    CreateSharedResources="$CREATE_SHARED_RESOURCES" \
  --resolve-s3 \
  --no-confirm-changeset

echo ""
echo "Next steps:"
if [ "$CREATE_SHARED_RESOURCES" = "true" ]; then
  echo "  1. Activate the receipt rule set once: SES Console (region $REGION) → Receipt rule sets → select 'custom-domain-email-rules' → Set as active."
fi
echo "  2. Add the MX record for $DOMAIN_NAME if not already (see README)."
if [ -n "$HOSTED_ZONE_ID" ]; then
  echo "  (SES domain + DKIM were created in Route 53; domain should verify automatically.)"
else
  echo "  (Verify the domain in SES if you have not already.)"
fi
echo "  For another domain: re-run this script; shared bucket/rule set are detected automatically."
