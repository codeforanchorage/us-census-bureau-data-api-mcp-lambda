resource "aws_secretsmanager_secret" "db" {
  name                    = "${local.lambda_name}/db"
  description             = "RDS master credentials for ${local.lambda_name}"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username       = aws_db_instance.mcp.username
    password       = random_password.db.result
    host           = aws_db_instance.mcp.address
    port           = aws_db_instance.mcp.port
    dbname         = aws_db_instance.mcp.db_name
    census_api_key = var.census_api_key
  })
}
