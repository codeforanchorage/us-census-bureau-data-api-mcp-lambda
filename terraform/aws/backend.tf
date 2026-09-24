terraform {
  backend "s3" {
    bucket  = "census-mcp-tfstate-420839047325-us-west-2"
    key     = "terraform.tfstate"
    region  = "us-west-2"
    encrypt = true
    # S3-native locking (Terraform >= 1.10): a <key>.tflock object next to
    # the state replaces the deprecated dynamodb_table argument. The
    # terraform-state-lock DynamoDB table still exists and is still created
    # by terraform/bootstrap -- other fleet stacks lock with it, so do NOT
    # remove it from bootstrap.
    use_lockfile = true
  }
}
