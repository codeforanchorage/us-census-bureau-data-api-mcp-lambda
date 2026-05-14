terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

locals {
  lambda_name     = var.lambda_name
  lambda_zip_path = "${path.module}/lambda-deployment.zip"
  lambda_zip_hash = fileexists(local.lambda_zip_path) ? filebase64sha256(local.lambda_zip_path) : ""
}

# ── Lambda IAM ───────────────────────────────────────────────────────────────

resource "aws_iam_role" "lambda_role" {
  name = "${local.lambda_name}-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda_secrets" {
  name = "${local.lambda_name}-secrets"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_secretsmanager_secret.db.arn
    }]
  })
}

# ── Lambda function ──────────────────────────────────────────────────────────

resource "aws_lambda_function" "mcp_server" {
  filename         = local.lambda_zip_path
  function_name    = local.lambda_name
  role             = aws_iam_role.lambda_role.arn
  handler          = "dist/lambda.handler"
  source_code_hash = local.lambda_zip_hash
  runtime          = "nodejs20.x"
  memory_size      = var.lambda_memory
  timeout          = var.lambda_timeout

  reserved_concurrent_executions = var.lambda_reserved_concurrency

  environment {
    variables = {
      DB_SECRET_ARN = aws_secretsmanager_secret.db.arn
      NODE_ENV      = "production"
      DEBUG_LOGS    = "true"
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.lambda_basic,
    aws_iam_role_policy.lambda_secrets,
    aws_db_instance.mcp,
  ]
}

resource "aws_cloudwatch_log_group" "lambda_logs" {
  name              = "/aws/lambda/${local.lambda_name}"
  retention_in_days = 14
}
