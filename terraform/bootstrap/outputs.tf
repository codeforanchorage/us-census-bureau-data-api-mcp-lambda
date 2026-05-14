output "state_bucket_name" {
  description = "S3 bucket storing Terraform remote state"
  value       = aws_s3_bucket.terraform_state.id
}

output "lock_table_name" {
  description = "DynamoDB table used for Terraform state locking"
  value       = aws_dynamodb_table.terraform_lock.name
}
