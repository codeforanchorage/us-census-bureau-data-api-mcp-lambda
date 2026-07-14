lambda_name                 = "census-mcp-prod"
stage_name                  = "prod"
aws_region                  = "us-west-2"
lambda_memory               = 1024
lambda_timeout              = 60
lambda_reserved_concurrency = 20

# NOTE: api_quota_limit is only enforced for requests carrying an API key;
# this endpoint is keyless, so the real ceiling is api_rate_limit. At 1 GB /
# ~1s per request, each 1 req/s of sustained allowance is ~$60-70/mo if
# fully saturated 24/7 — api_rate_limit is the cost-ceiling dial.
api_quota_limit = 10000
api_rate_limit  = 25
api_burst_limit = 100

custom_domain        = "us-census.codeforanchorage.org"
db_instance_class    = "db.t4g.micro"
db_allocated_storage = 20

# Cost safeguards (see cost_controls.tf and waf.tf). alert_email is set only
# in prod — the budget and anomaly monitor watch the whole account.
alert_email          = "brendanbabb@gmail.com"
monthly_budget_limit = 50
enable_waf           = true
debug_logs           = false
