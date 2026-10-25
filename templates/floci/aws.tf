terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# Everything emulator-specific is a variable so the same configuration can point
# at Floci locally and at real AWS later, with no code change.
variable "aws_endpoint" {
  description = "Floci AWS endpoint. Empty means real AWS."
  type        = string
  default     = "http://localhost.floci.io:4566"
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "bucket_name" {
  type    = string
  default = "iac-floci-demo"
}

# Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (floci sets
# both to "test"). Keep them out of the configuration so nothing secret lands in
# the plan file or state.
provider "aws" {
  region = var.aws_region

  # These five switches are what emulators require. Without them the provider
  # tries IMDS lookups, validates the region against real AWS, and mangles S3
  # hostnames into virtual-host form the emulator will not answer.
  endpoints {
    s3 = var.aws_endpoint
  }

  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true
}

resource "aws_s3_bucket" "demo" {
  bucket = var.bucket_name

  tags = {
    iac_mode = "cloud-emulation"
  }
}

resource "aws_s3_bucket_versioning" "demo" {
  bucket = aws_s3_bucket.demo.id

  versioning_configuration {
    status = "Enabled"
  }
}

output "bucket" {
  value = aws_s3_bucket.demo.bucket
}

output "endpoint" {
  description = "Where the bucket actually lives during this run."
  value       = var.aws_endpoint
}
