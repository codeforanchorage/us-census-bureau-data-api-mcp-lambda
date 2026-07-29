# Per-client fairness: the API Gateway stage throttle (api_rate_limit) is an
# AGGREGATE cap, so a single runaway client can consume the entire allowance
# and starve real users while maxing spend. This WAF rate-based rule blocks
# any single IP that exceeds waf_rate_limit requests in a 5-minute window,
# while leaving the endpoint open (no API keys) for MCP clients.
#
# Cost: ~$5/mo web ACL + $1/mo rule + $0.60 per million requests, so it is
# opt-in via enable_waf (on for prod, off for staging).

locals {
  # Create this MCP's OWN web ACL only when it is not delegating to the
  # fleet-wide one (mcp-stats/terraform/aws/shared_waf.tf). WAF bills ~$5/mo per
  # web ACL + $1/mo per rule regardless of traffic, so a dedicated ACL is fixed
  # cost; the shared ACL carries this MCP's rate limit as a Host-scoped rule.
  #
  # NOTE: once use_shared_waf is true, waf_rate_limit is no longer read here —
  # the effective limit lives in mcp-stats' `fleet_waf_members`.
  waf_enabled = var.enable_waf && !var.use_shared_waf

  # The stage gets associated under either path.
  waf_associated = local.waf_enabled || var.use_shared_waf
}

# The shared ACL lives in a different Terraform state (mcp-stats), so its ARN
# comes via SSM rather than a cross-state remote read.
data "aws_ssm_parameter" "shared_waf_arn" {
  count = var.use_shared_waf ? 1 : 0

  name = var.shared_waf_ssm_parameter
}

resource "aws_wafv2_web_acl" "mcp" {
  count = local.waf_enabled ? 1 : 0

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
  count = local.waf_associated ? 1 : 0

  resource_arn = aws_api_gateway_stage.stage.arn

  # Splat + one() instead of indexing [0]: exactly one of these lists is
  # non-empty and one([]) is null, so the inactive branch cannot blow up with
  # an index-out-of-range while the ternary is being evaluated.
  web_acl_arn = var.use_shared_waf ? one(data.aws_ssm_parameter.shared_waf_arn[*].value) : one(aws_wafv2_web_acl.mcp[*].arn)
}
