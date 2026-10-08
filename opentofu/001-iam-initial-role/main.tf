resource "aws_iam_role" "isb_infra_setup" {
  name = "${var.environment}_isb_infra_setup"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          },
          StringLike = {
            "token.actions.githubusercontent.com:sub" = "repo:dtoakley-tw/innovation-sandbox-on-aws:*",
          }
        }
      }
    ]
  })
}

data "aws_iam_policy_document" "iam_management_policy_statement" {
  statement {
    actions = [
      "iam:Get*",
      "iam:List*",
      "iam:AttachRolePolicy",
      "iam:PutRolePolicy",
      "iam:PassRole",
      "iam:CreateRole",
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
      "iam:TagRole",
      "iam:TagPolicy",
      "iam:UntagRole",
      "iam:UntagPolicy",
      "iam:DetachRolePolicy",
      "iam:DeleteRole",
      "iam:DeletePolicy",
      "iam:DeleteRolePolicy",
      "iam:DeletePolicyVersion",
    ]
    resources = ["*"]
    effect    = "Allow"
  }
}

resource "aws_iam_policy" "iam_management_policy" {
  name        = "${var.environment}_isb_infra_iam_management"
  description = "A policy that allows managing IAM resources."

  policy = data.aws_iam_policy_document.iam_management_policy_statement.json
}

resource "aws_iam_role_policy_attachment" "attach_iam_management_policy" {
  role       = aws_iam_role.isb_infra_setup.name
  policy_arn = aws_iam_policy.iam_management_policy.arn
}

# data "aws_iam_policy_document" "secrets_policy_statement" {
#   statement {
#     actions = [
#       "secretsmanager:ListSecrets",
#       "secretsmanager:GetSecretValue"
#     ]
#     resources = ["*"]
#     effect    = "Allow"
#   }
# }
#
# resource "aws_iam_policy" "read_secrets_policy" {
#   name        = "${var.environment}_isb_infra_read_secrets"
#   description = "A policy that allows reading secrets from Secrets Manager."
#
#   policy = data.aws_iam_policy_document.secrets_policy_statement.json
# }
#
# resource "aws_iam_role_policy_attachment" "attach_read_secrets_policy" {
#   role       = aws_iam_role.isb_infra_setup.name
#   policy_arn = aws_iam_policy.read_secrets_policy.arn
# }

data "aws_iam_policy_document" "s3_bucket_access_statement" {
  statement {
    actions = [
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = [
      "arn:aws:s3:::sandbox-infra-opentofu-${var.environment}/*",
    ]
    effect = "Allow"
  }

  statement {
    actions = [
      "s3:ListBucket",
      "s3:GetBucketPolicy",
    ]
    resources = [
      "arn:aws:s3:::sandbox-infra-opentofu-${var.environment}",
    ]
    effect = "Allow"
  }

  statement {
    actions = [
      "s3:CreateBucket",
    ]
    resources = [
      "arn:aws:s3:::sandbox-infra-opentofu-*",
    ]
    effect = "Allow"
  }
}

resource "aws_iam_role_policy_attachment" "attach_read_access" {
  role       = aws_iam_role.isb_infra_setup.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_policy" "opentofu_backend_bucket_access" {
  name        = "${var.environment}_opentofu_backend_bucket_access"
  description = "A policy that gives access to s3 bucket for opentofu backend"

  policy = data.aws_iam_policy_document.s3_bucket_access_statement.json
}

resource "aws_iam_role_policy_attachment" "attach_opentofu_backend_bucket_access" {
  role       = aws_iam_role.isb_infra_setup.name
  policy_arn = aws_iam_policy.opentofu_backend_bucket_access.arn
}
