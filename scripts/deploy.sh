#!/bin/bash
# Census MCP Lambda deployment script
# Packages mcp-server as a Lambda zip and applies the Terraform stack.
#
# Prereqs (run once):
#   1. AWS CLI configured with credentials for account 420839047325
#   2. cd terraform/bootstrap && terraform init && terraform apply
#      (creates the S3 state bucket + DynamoDB lock table)
#   3. Set CENSUS_API_KEY in your environment (or pass via -var)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

ENVIRONMENT=""
TF_WORKSPACE=""

show_usage() {
    echo "Usage: $0 --environment <staging|prod> [--tfworkspace <name>]"
    echo ""
    echo "Options:"
    echo "  --environment, -e   Deployment environment: staging or prod (required)"
    echo "  --tfworkspace, -w   Terraform workspace (default: census-staging or census-prod)"
    echo "  --help, -h          Show this help message"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --environment|-e)
            ENVIRONMENT="$2"; shift 2 ;;
        --tfworkspace|-w)
            TF_WORKSPACE="$2"; shift 2 ;;
        --help|-h)
            show_usage; exit 0 ;;
        *)
            echo -e "${RED}Unknown argument '${1}'${NC}"; show_usage; exit 1 ;;
    esac
done

if [ -z "$ENVIRONMENT" ]; then
    echo -e "${RED}--environment is required${NC}"; show_usage; exit 1
fi
if [ "$ENVIRONMENT" != "staging" ] && [ "$ENVIRONMENT" != "prod" ]; then
    echo -e "${RED}Invalid environment '${ENVIRONMENT}'${NC}"; show_usage; exit 1
fi
if [ -z "${CENSUS_API_KEY:-}" ]; then
    echo -e "${RED}CENSUS_API_KEY env var is required${NC}"
    echo "Get one at https://api.census.gov/data/key_signup.html"
    exit 1
fi

if [ -z "$TF_WORKSPACE" ]; then
    TF_WORKSPACE="census-${ENVIRONMENT}"
fi

echo -e "${GREEN}Census MCP Deployment [${ENVIRONMENT}] (workspace: ${TF_WORKSPACE})${NC}"
echo "================================"

# ── Tool checks ─────────────────────────────────────────────────────────────

for tool in node npm terraform aws; do
    if ! command -v "$tool" &> /dev/null; then
        echo -e "${RED}${tool} not found${NC}"; exit 1
    fi
done

# ── Build mcp-server ────────────────────────────────────────────────────────

echo -e "${YELLOW}Building mcp-server...${NC}"
pushd mcp-server > /dev/null
npm ci
npm run build
popd > /dev/null

# ── Package Lambda zip ──────────────────────────────────────────────────────

echo -e "${YELLOW}Packaging Lambda zip...${NC}"

PACKAGE_DIR=".deploy"
rm -rf "$PACKAGE_DIR"
mkdir -p "$PACKAGE_DIR"

cp -r mcp-server/dist "$PACKAGE_DIR/dist"
cp mcp-server/package.json "$PACKAGE_DIR/"
cp mcp-server/package-lock.json "$PACKAGE_DIR/"

# Install production deps directly into the package dir so they land at the
# zip root next to dist/ — Lambda resolves node_modules from the zip root.
pushd "$PACKAGE_DIR" > /dev/null
npm ci --omit=dev --ignore-scripts
popd > /dev/null

ZIP_FILE="lambda-deployment.zip"
rm -f "$ZIP_FILE"

node - "$ZIP_FILE" "$PACKAGE_DIR" <<'JS'
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const zipPath = path.resolve(process.argv[2]);
const dir = path.resolve(process.argv[3]);

function has(cmd) {
  try {
    execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (has('zip')) {
  // -X drops extra file attributes; zip stores entries with forward slashes.
  execSync(`zip -rX "${zipPath}" .`, { cwd: dir, stdio: 'inherit' });
} else if (process.platform === 'win32') {
  // Windows PowerShell 5.1's Compress-Archive writes BACKSLASH path separators,
  // which AWS Lambda's Linux runtime cannot resolve (the handler fails to load).
  // Build the zip via .NET ZipArchive and normalize every entry name to forward
  // slashes. [char]92 = '\', [char]47 = '/' (kept as codes to avoid escaping).
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    '$bs = [char]92; $fs = [char]47',
    'Add-Type -AssemblyName System.IO.Compression',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$zipPath = $args[0]; $dir = $args[1]',
    'if (Test-Path $zipPath) { Remove-Item $zipPath -Force }',
    'Push-Location $dir',
    'try {',
    "  $zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')",
    '  try {',
    '    Get-ChildItem -Recurse -File | ForEach-Object {',
    "      $rel = (Resolve-Path -Relative $_.FullName).TrimStart('.').TrimStart($bs, $fs).Replace($bs, $fs)",
    '      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal)',
    '    }',
    '  } finally { $zip.Dispose() }',
    '} finally { Pop-Location }',
  ].join('\n');
  // Write to the temp dir, NOT the package dir -- a .ps1 inside `dir` would be
  // swept into the zip.
  const tmp = path.join(os.tmpdir(), `lambda-zip-${process.pid}.ps1`);
  fs.writeFileSync(tmp, ps);
  try {
    execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}" "${zipPath}" "${dir}"`,
      { stdio: 'inherit' },
    );
  } finally {
    fs.unlinkSync(tmp);
  }
} else {
  throw new Error(
    "Cannot package: the 'zip' binary is not installed. Install it " +
      "(e.g. 'sudo apt-get install zip' or 'brew install zip') and re-run.",
  );
}

console.log(`Wrote ${zipPath} (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)`);
JS

cp "$ZIP_FILE" terraform/aws/lambda-deployment.zip
echo -e "${GREEN}Lambda package: $ZIP_FILE${NC}"

# ── Terraform apply ─────────────────────────────────────────────────────────

cd terraform/aws

if [ ! -d ".terraform" ]; then
    echo -e "${YELLOW}Initializing Terraform...${NC}"
    terraform init
fi

echo -e "${YELLOW}Selecting workspace: ${TF_WORKSPACE}${NC}"
terraform workspace select "$TF_WORKSPACE" 2>/dev/null || terraform workspace new "$TF_WORKSPACE"

echo -e "${YELLOW}Planning...${NC}"
if ! terraform plan \
    -out=tfplan \
    -var-file="${ENVIRONMENT}.tfvars" \
    -var="census_api_key=${CENSUS_API_KEY}"; then
    echo -e "${RED}Terraform plan failed${NC}"; exit 1
fi

echo ""
echo -e "${YELLOW}Apply the planned changes?${NC}"
echo -e "  Environment: ${ENVIRONMENT}"
echo -e "  Workspace:   ${TF_WORKSPACE}"
echo ""
read -r -p "Type 'yes' to proceed: " CONFIRM
if [ "$CONFIRM" != "yes" ] && [ "$CONFIRM" != "y" ]; then
    echo -e "${YELLOW}Cancelled${NC}"
    rm -f tfplan
    exit 0
fi

terraform apply tfplan
rm -f tfplan

API_URL=$(terraform output -raw api_gateway_url 2>/dev/null || echo "")
RDS_ENDPOINT=$(terraform output -raw rds_endpoint 2>/dev/null || echo "")
SECRET_ARN=$(terraform output -raw db_secret_arn 2>/dev/null || echo "")

echo ""
echo -e "${GREEN}Deployment complete${NC}"
echo ""
echo "API Gateway URL (for Claude Connectors):"
echo -e "${GREEN}  $API_URL${NC}"
echo ""
echo "RDS endpoint: $RDS_ENDPOINT"
echo "Secret ARN:   $SECRET_ARN"
echo ""
echo "If this is a fresh deploy, run the DB seed now — see README section 'Seed the database'."
