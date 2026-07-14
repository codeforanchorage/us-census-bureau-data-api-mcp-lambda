# Cost safeguards: budget alerts, cost anomaly detection, and CloudWatch
# alarms for the metrics that precede a surprise bill (traffic spike, Lambda
# throttling, RDS credit exhaustion).
#
# All resources here are gated on alert_email being set. Set it in ONE
# tfvars file only (prod) — the budget and anomaly monitor watch the whole
# AWS account, so creating them from both workspaces would duplicate alerts.
#
# Note: the SNS email subscription and the anomaly subscription each send a
# confirmation email on first apply that must be clicked before alerts flow.

locals {
  alerts_enabled = var.alert_email != ""
}

# ── AWS Budget: hard-dollar early warning ────────────────────────────────────

resource "aws_budgets_budget" "monthly" {
  count = local.alerts_enabled ? 1 : 0

  name         = "${local.lambda_name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_limit)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 150
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}

# ── Cost anomaly detection ───────────────────────────────────────────────────

resource "aws_ce_anomaly_monitor" "services" {
  count = local.alerts_enabled ? 1 : 0

  name              = "${local.lambda_name}-service-monitor"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "daily_email" {
  count = local.alerts_enabled ? 1 : 0

  name             = "${local.lambda_name}-anomaly-alerts"
  frequency        = "DAILY"
  monitor_arn_list = [aws_ce_anomaly_monitor.services[0].arn]

  subscriber {
    type    = "EMAIL"
    address = var.alert_email
  }

  # Only alert on anomalies with at least $10 of total impact.
  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = ["10"]
    }
  }
}

# ── CloudWatch alarms → SNS → email ─────────────────────────────────────────

resource "aws_sns_topic" "alerts" {
  count = local.alerts_enabled ? 1 : 0

  name = "${local.lambda_name}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count = local.alerts_enabled ? 1 : 0

  topic_arn = aws_sns_topic.alerts[0].arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# Traffic is far above normal — decide whether this is growth or abuse.
resource "aws_cloudwatch_metric_alarm" "api_daily_requests" {
  count = local.alerts_enabled ? 1 : 0

  alarm_name          = "${local.lambda_name}-daily-requests"
  alarm_description   = "API Gateway received more than ${var.daily_request_alarm_threshold} requests in a day — traffic is far above normal."
  namespace           = "AWS/ApiGateway"
  metric_name         = "Count"
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = var.daily_request_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ApiName = aws_api_gateway_rest_api.mcp_api.name
    Stage   = var.stage_name
  }

  alarm_actions = [aws_sns_topic.alerts[0].arn]
  ok_actions    = [aws_sns_topic.alerts[0].arn]
}

# Users are being turned away — decide whether to raise concurrency/limits.
resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  count = local.alerts_enabled ? 1 : 0

  alarm_name          = "${local.lambda_name}-lambda-throttles"
  alarm_description   = "Lambda invocations are being throttled (reserved concurrency exhausted) for 15+ minutes — real users are likely seeing errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.mcp_server.function_name
  }

  alarm_actions = [aws_sns_topic.alerts[0].arn]
  ok_actions    = [aws_sns_topic.alerts[0].arn]
}

# The burstable DB is running out of CPU credits and is about to slow down.
resource "aws_cloudwatch_metric_alarm" "rds_cpu_credits" {
  count = local.alerts_enabled ? 1 : 0

  alarm_name          = "${local.lambda_name}-rds-cpu-credits"
  alarm_description   = "RDS CPU credit balance is low — sustained load is draining the t4g burst credits and queries will slow down soon."
  namespace           = "AWS/RDS"
  metric_name         = "CPUCreditBalance"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 30
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.mcp.identifier
  }

  alarm_actions = [aws_sns_topic.alerts[0].arn]
  ok_actions    = [aws_sns_topic.alerts[0].arn]
}
