# Per-client fairness: the API Gateway stage throttle (api_rate_limit) is an
# AGGREGATE cap, so a single runaway client can consume the entire allowance
# and starve real users while maxing spend. This WAF rate-based rule blocks
# any single IP that exceeds waf_rate_limit requests in a 5-minute window,
# while leaving the endpoint open (no API keys) for MCP clients.
#
# Cost: ~$5/mo web ACL + $1/mo rule + $0.60 per million requests, so it is
# opt-in via enable_waf (on for prod, off for staging).

resource "aws_wafv2_web_acl" "mcp" {
  count = var.enable_waf ? 1 : 0

  name        = "${local.lambda_name}-waf"
  description = "Per-IP rate limiting for ${local.lambda_name}"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "per-ip-rate-limit"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.waf_rate_limit
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.lambda_name}-per-ip-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.lambda_name}-waf"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "mcp" {
  count = var.enable_waf ? 1 : 0

  resource_arn = aws_api_gateway_stage.stage.arn
  web_acl_arn  = aws_wafv2_web_acl.mcp[0].arn
}
