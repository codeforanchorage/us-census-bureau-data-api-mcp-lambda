lambda_name                 = "census-mcp-staging"
stage_name                  = "staging"
aws_region                  = "us-west-2"
lambda_memory               = 512
lambda_timeout              = 30
lambda_reserved_concurrency = 10
api_quota_limit             = 3000
api_rate_limit              = 5
api_burst_limit             = 10
db_instance_class           = "db.t4g.micro"
db_allocated_storage        = 20

# Verbose logging is fine in staging; keep alert_email/enable_waf unset here
# so account-wide cost alerting lives only in the prod workspace.
debug_logs = true
