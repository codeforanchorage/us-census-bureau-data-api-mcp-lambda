# Public-subnet RDS. Protection is SSL + strong password, NOT security group.
# This is the cost compromise that lets Lambda stay out of a VPC and avoid a
# NAT Gateway ($32/mo). Do not use this posture for sensitive data without
# tightening the SG to your laptop's IP during seed and switching Lambda to
# the VPC + NAT pattern afterward.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_db_subnet_group" "mcp" {
  name       = "${local.lambda_name}-db-subnets"
  subnet_ids = data.aws_subnets.default.ids
}

resource "aws_security_group" "rds" {
  name        = "${local.lambda_name}-rds"
  description = "RDS access for ${local.lambda_name}"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "Postgres from the public internet (protected by SSL + password)"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_parameter_group" "mcp" {
  name   = "${local.lambda_name}-pg16"
  family = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

resource "random_password" "db" {
  length  = 32
  special = true
  # RDS master password disallows / @ " and spaces
  override_special = "!#$%&*()-_=+[]{}:?"
}

resource "aws_db_instance" "mcp" {
  identifier     = "${local.lambda_name}-db"
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.mcp.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.mcp.name

  publicly_accessible = true
  multi_az            = false
  skip_final_snapshot = true
  deletion_protection = false

  backup_retention_period = 1
  apply_immediately       = true
}
