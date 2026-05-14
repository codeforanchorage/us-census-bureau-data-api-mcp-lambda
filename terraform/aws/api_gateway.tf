resource "aws_api_gateway_rest_api" "mcp_api" {
  name        = "${local.lambda_name}-api"
  description = "API Gateway for Census MCP Server"

  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

resource "aws_api_gateway_resource" "mcp" {
  rest_api_id = aws_api_gateway_rest_api.mcp_api.id
  parent_id   = aws_api_gateway_rest_api.mcp_api.root_resource_id
  path_part   = "mcp"
}

resource "aws_api_gateway_method" "mcp_post" {
  rest_api_id      = aws_api_gateway_rest_api.mcp_api.id
  resource_id      = aws_api_gateway_resource.mcp.id
  http_method      = "POST"
  authorization    = "NONE"
  api_key_required = false
}

resource "aws_api_gateway_method" "mcp_options" {
  rest_api_id      = aws_api_gateway_rest_api.mcp_api.id
  resource_id      = aws_api_gateway_resource.mcp.id
  http_method      = "OPTIONS"
  authorization    = "NONE"
  api_key_required = false
}

resource "aws_api_gateway_integration" "mcp_post_integration" {
  rest_api_id = aws_api_gateway_rest_api.mcp_api.id
  resource_id = aws_api_gateway_resource.mcp.id
  http_method = aws_api_gateway_method.mcp_post.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.mcp_server.invoke_arn
}

resource "aws_api_gateway_integration" "mcp_options_integration" {
  rest_api_id = aws_api_gateway_rest_api.mcp_api.id
  resource_id = aws_api_gateway_resource.mcp.id
  http_method = aws_api_gateway_method.mcp_options.http_method

  type = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "mcp_post_response_200" {
  rest_api_id = aws_api_gateway_rest_api.mcp_api.id
  resource_id = aws_api_gateway_resource.mcp.id
  http_method = aws_api_gateway_method.mcp_post.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Origin"  = true
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
  }
}

resource "aws_api_gateway_method_response" "mcp_options_response_200" {
  rest_api_id = aws_api_gateway_rest_api.mcp_api.id
  resource_id = aws_api_gateway_resource.mcp.id
  http_method = aws_api_gateway_method.mcp_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Origin"  = true
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
  }
}

resource "aws_api_gateway_integration_response" "mcp_options_integration_response" {
  rest_api_id = aws_api_gateway_rest_api.mcp_api.id
  resource_id = aws_api_gateway_resource.mcp.id
  http_method = aws_api_gateway_method.mcp_options.http_method
  status_code = aws_api_gateway_method_response.mcp_options_response_200.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
    "method.response.header.Access-Control-Allow-Headers" = "'content-type,mcp-session-id'"
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,POST'"
  }

  response_templates = {
    "application/json" = ""
  }

  depends_on = [aws_api_gateway_integration.mcp_options_integration]
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.mcp_server.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.mcp_api.execution_arn}/*/*"
}

resource "aws_api_gateway_deployment" "mcp_deployment" {
  rest_api_id = aws_api_gateway_rest_api.mcp_api.id

  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_resource.mcp.id,
      aws_api_gateway_method.mcp_post.id,
      aws_api_gateway_method.mcp_options.id,
      aws_api_gateway_integration.mcp_post_integration.id,
      aws_api_gateway_integration.mcp_options_integration.id,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    aws_api_gateway_method.mcp_post,
    aws_api_gateway_method.mcp_options,
    aws_api_gateway_integration.mcp_post_integration,
    aws_api_gateway_integration.mcp_options_integration,
    aws_api_gateway_method_response.mcp_post_response_200,
    aws_api_gateway_method_response.mcp_options_response_200,
    aws_api_gateway_integration_response.mcp_options_integration_response,
  ]
}

# API Gateway needs an account-level role to write logs to CloudWatch.
# This is a per-region, per-account setting.

resource "aws_iam_role" "api_gateway_cloudwatch" {
  name = "${local.lambda_name}-apigw-cloudwatch"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "apigateway.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "api_gateway_cloudwatch" {
  role       = aws_iam_role.api_gateway_cloudwatch.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs"
}

resource "aws_api_gateway_account" "this" {
  cloudwatch_role_arn = aws_iam_role.api_gateway_cloudwatch.arn

  depends_on = [aws_iam_role_policy_attachment.api_gateway_cloudwatch]
}

resource "aws_cloudwatch_log_group" "api_gateway_access_logs" {
  name              = "/aws/apigateway/${local.lambda_name}-access"
  retention_in_days = 14

  tags = {
    Project = "mcp-server"
  }
}

resource "aws_api_gateway_stage" "stage" {
  deployment_id = aws_api_gateway_deployment.mcp_deployment.id
  rest_api_id   = aws_api_gateway_rest_api.mcp_api.id
  stage_name    = var.stage_name

  xray_tracing_enabled = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway_access_logs.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      resourcePath   = "$context.resourcePath"
      status         = "$context.status"
      responseLength = "$context.responseLength"
    })
  }

  depends_on = [aws_api_gateway_account.this]
}

resource "aws_api_gateway_method_settings" "mcp_post" {
  rest_api_id = aws_api_gateway_rest_api.mcp_api.id
  stage_name  = aws_api_gateway_stage.stage.stage_name
  method_path = "*/*"

  settings {
    throttling_burst_limit = var.api_burst_limit
    throttling_rate_limit  = var.api_rate_limit
  }
}

resource "aws_api_gateway_usage_plan" "mcp_usage_plan" {
  name = "${local.lambda_name}-usage-plan"

  api_stages {
    api_id = aws_api_gateway_rest_api.mcp_api.id
    stage  = aws_api_gateway_stage.stage.stage_name
  }

  quota_settings {
    limit  = var.api_quota_limit
    period = "DAY"
  }

  throttle_settings {
    burst_limit = var.api_burst_limit
    rate_limit  = var.api_rate_limit
  }
}
