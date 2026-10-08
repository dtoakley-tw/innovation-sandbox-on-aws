resource "aws_s3_bucket" "opentofu_state" {
  bucket = var.bucket_name
}
