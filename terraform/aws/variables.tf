variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "us-west-2"
}

variable "lambda_name" {
  description = "Name of the Lambda function"
  type        = string
  default     = "census-mcp-staging"
}

variable "lambda_memory" {
  description = "Lambda memory in MB"
  type        = number
  default     = 512
}

variable "lambda_timeout" {
  description = "Lambda timeout in seconds"
  type        = number
  default     = 60
}

variable "lambda_reserved_concurrency" {
  description = "Maximum concurrent Lambda invocations. Caps fan-out to RDS (db.t4g.micro ceiling is ~87). Set to -1 to disable."
  type        = number
  default     = 10
}

variable "stage_name" {
  description = "API Gateway stage name"
  type        = string
  default     = "staging"
}

variable "api_quota_limit" {
  description = "API Gateway daily request quota"
  type        = number
  default     = 3000
}

variable "api_rate_limit" {
  description = "API Gateway requests per second rate limit"
  type        = number
  default     = 5
}

variable "api_burst_limit" {
  description = "API Gateway burst limit"
  type        = number
  default     = 10
}

variable "census_api_key" {
  description = "Census Bureau Data API key injected into the Lambda env"
  type        = string
  sensitive   = true
}

variable "custom_domain" {
  description = "Custom domain name for the API Gateway (e.g. us-census.codeforanchorage.org). Leave empty to skip custom domain setup."
  type        = string
  default     = ""
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "RDS allocated storage (GB)"
  type        = number
  default     = 20
}

variable "db_name" {
  description = "Initial Postgres database name"
  type        = string
  default     = "mcp_db"
}

variable "db_username" {
  description = "Master username for the RDS instance"
  type        = string
  default     = "mcp_admin"
}

variable "db_engine_version" {
  description = "Postgres engine version"
  type        = string
  default     = "16.13"
}
