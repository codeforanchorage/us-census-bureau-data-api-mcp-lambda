terraform {
  backend "s3" {
    bucket         = "census-mcp-tfstate-420839047325-us-west-2"
    key            = "terraform.tfstate"
    region         = "us-west-2"
    dynamodb_table = "terraform-state-lock"
    encrypt        = true
  }
}
