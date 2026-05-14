variable "aws_region" {
  description = "AWS region to create state backend in"
  type        = string
  default     = "us-west-2"
}

variable "state_bucket_name" {
  description = "S3 bucket name for Terraform remote state"
  type        = string
  default     = "census-mcp-tfstate-420839047325-us-west-2"
}

variable "lock_table_name" {
  description = "DynamoDB table name for Terraform state locking"
  type        = string
  default     = "terraform-state-lock"
}
