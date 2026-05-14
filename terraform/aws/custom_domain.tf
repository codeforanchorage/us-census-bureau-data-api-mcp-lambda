# Custom domain for API Gateway (optional — set var.custom_domain to enable).
#
# After applying, add two CNAME records in your DNS provider (e.g. Dreamhost):
#
#   1. ACM validation:
#        Name:  <acm_validation_cname_name output>
#        Value: <acm_validation_cname_value output>
#
#   2. Domain routing:
#        Name:  us-census.codeforanchorage.org
#        Value: <custom_domain_target output>
#
# The ACM certificate won't validate (and the custom domain won't work)
# until the validation CNAME is in place.

# ── ACM Certificate ─────────────────────────────────────────────────────────

resource "aws_acm_certificate" "api" {
  count             = var.custom_domain != "" ? 1 : 0
  domain_name       = var.custom_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# ── API Gateway Custom Domain ───────────────────────────────────────────────

resource "aws_api_gateway_domain_name" "custom" {
  count           = var.custom_domain != "" ? 1 : 0
  domain_name     = var.custom_domain
  regional_certificate_arn = aws_acm_certificate.api[0].arn

  endpoint_configuration {
    types = ["REGIONAL"]
  }

  depends_on = [aws_acm_certificate.api]
}

resource "aws_api_gateway_base_path_mapping" "custom" {
  count       = var.custom_domain != "" ? 1 : 0
  api_id      = aws_api_gateway_rest_api.mcp_api.id
  stage_name  = aws_api_gateway_stage.stage.stage_name
  domain_name = aws_api_gateway_domain_name.custom[0].domain_name
}
