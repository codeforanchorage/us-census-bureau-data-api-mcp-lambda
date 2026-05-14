#!/bin/bash
# One-time Terraform backend bootstrap for Census MCP Lambda.
# Creates the S3 state bucket and DynamoDB lock table.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)
AWS_REGION=$(aws configure get region 2>/dev/null || echo "us-west-2")

if [ -z "${AWS_ACCOUNT_ID:-}" ]; then
    echo -e "${RED}Could not resolve AWS account id. Run 'aws configure' first.${NC}"
    exit 1
fi

BUCKET="census-mcp-tfstate-${AWS_ACCOUNT_ID}-${AWS_REGION}"

echo "Account:  $AWS_ACCOUNT_ID"
echo "Region:   $AWS_REGION"
echo "Bucket:   $BUCKET"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../terraform/bootstrap"

terraform init
terraform apply \
    -var="aws_region=${AWS_REGION}" \
    -var="state_bucket_name=${BUCKET}"

echo ""
echo -e "${GREEN}Backend ready. Main stack will use:${NC}"
echo "  bucket = $BUCKET"
echo "  table  = terraform-state-lock"
echo ""
echo "Next: cd terraform/aws && terraform init"
