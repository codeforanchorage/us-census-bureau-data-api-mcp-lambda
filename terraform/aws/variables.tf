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

variable "debug_logs" {
  description = "Enable verbose Lambda logging (DEBUG_LOGS env var). Keep off in prod: log ingestion is $0.50/GB and verbose logs are the largest discretionary cost under load."
  type        = bool
  default     = false
}

variable "alert_email" {
  description = "Email address for budget alerts, cost anomaly alerts, and CloudWatch alarms. Leave empty to skip creating all cost-alerting resources (budget, anomaly monitor, SNS topic, alarms)."
  type        = string
  default     = ""
}

variable "monthly_budget_limit" {
  description = "Monthly account cost budget in USD. Alerts fire at 50% and 100% actual and 150% forecasted."
  type        = number
  default     = 50
}

variable "daily_request_alarm_threshold" {
  description = "Alarm when API Gateway requests in a single day exceed this count (early warning that traffic is far above normal)."
  type        = number
  default     = 50000
}

variable "enable_waf" {
  description = "Attach a WAF web ACL with a per-IP rate limit to the API Gateway stage. Costs ~$6/mo fixed + $0.60 per million requests; prevents a single client from consuming the entire stage throttle."
  type        = bool
  default     = false
}

variable "waf_rate_limit" {
  description = "WAF per-IP rate limit: maximum requests from one IP in any 5-minute window before it is blocked."
  type        = number
  default     = 300
}
