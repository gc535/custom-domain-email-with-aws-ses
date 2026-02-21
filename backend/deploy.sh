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

echo ""
echo "Using: Project=$PROJECT_NAME, Domain=$DOMAIN_NAME, Inbox=$INBOX_EMAIL, Region=$REGION"
[ -n "$HOSTED_ZONE_ID" ] && echo "SES domain verification: enabled (DKIM records will be created in Route 53)"
echo ""

echo "Installing dependencies..."
npm install --production --silent

echo "Building..."
sam build

echo "Deploying..."
sam deploy \
  --stack-name "${PROJECT_NAME}" \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --region "$REGION" \
  --parameter-overrides \
    ProjectName="$PROJECT_NAME" \
    DomainName="$DOMAIN_NAME" \
    InboxEmail="$INBOX_EMAIL" \
    Region="$REGION" \
    HostedZoneId="${HOSTED_ZONE_ID:-}" \
  --resolve-s3 \
  --no-confirm-changeset

echo ""
echo "Next steps:"
echo "  1. Activate the receipt rule set: SES Console (region $REGION) → Receipt rule sets → select the rule set from stack output → Set as active."
echo "  2. Add the MX record for $DOMAIN_NAME (see README)."
if [ -n "$HOSTED_ZONE_ID" ]; then
  echo "  (SES domain + DKIM were created in Route 53; domain should verify automatically.)"
else
  echo "  (Verify the domain in SES if you have not already.)"
fi
