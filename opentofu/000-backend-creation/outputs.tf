output "s3_bucket_arn" {
  value = aws_s3_bucket.opentofu_state.arn
}
output "s3_bucket_name" {
  value = aws_s3_bucket.opentofu_state.bucket
}
