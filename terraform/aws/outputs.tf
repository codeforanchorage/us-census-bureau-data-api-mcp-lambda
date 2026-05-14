output "lambda_function_name" {
  description = "Name of the Lambda function"
  value       = aws_lambda_function.mcp_server.function_name
}

output "lambda_function_arn" {
  description = "ARN of the Lambda function"
  value       = aws_lambda_function.mcp_server.arn
}

output "cloudwatch_log_group" {
  description = "CloudWatch Log Group name"
  value       = aws_cloudwatch_log_group.lambda_logs.name
}

output "api_gateway_url" {
  description = "API Gateway URL for MCP server (use with Claude Connectors)"
  value       = "${aws_api_gateway_stage.stage.invoke_url}/mcp"
}

output "rds_endpoint" {
  description = "RDS instance endpoint (host:port)"
  value       = aws_db_instance.mcp.endpoint
}

output "rds_address" {
  description = "RDS instance hostname"
  value       = aws_db_instance.mcp.address
}

output "db_secret_arn" {
  description = "Secrets Manager ARN holding the RDS master credentials"
  value       = aws_secretsmanager_secret.db.arn
}

output "db_secret_name" {
  description = "Secrets Manager secret name"
  value       = aws_secretsmanager_secret.db.name
}

# ── Custom domain outputs ───────────────────────────────────────────────────

output "custom_domain_url" {
  description = "Custom domain URL for MCP server"
  value       = var.custom_domain != "" ? "https://${var.custom_domain}/mcp" : ""
}

output "custom_domain_target" {
  description = "CNAME target for the custom domain — add this as a CNAME in your DNS provider"
  value       = var.custom_domain != "" ? aws_api_gateway_domain_name.custom[0].regional_domain_name : ""
}

output "acm_validation_cname_name" {
  description = "ACM certificate DNS validation CNAME name — add this record in your DNS provider"
  value       = var.custom_domain != "" ? tolist(aws_acm_certificate.api[0].domain_validation_options)[0].resource_record_name : ""
}

output "acm_validation_cname_value" {
  description = "ACM certificate DNS validation CNAME value"
  value       = var.custom_domain != "" ? tolist(aws_acm_certificate.api[0].domain_validation_options)[0].resource_record_value : ""
}
