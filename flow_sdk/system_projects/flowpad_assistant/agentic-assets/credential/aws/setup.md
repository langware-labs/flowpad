Get an AWS access key that can read and write the bucket.
1. Open https://console.aws.amazon.com/iam/home#/security_credentials and sign in (ask the person to sign in if needed — never create an account).
2. Under "Access keys", create one (or use an IAM user limited to the bucket) and copy the Access key ID and the Secret access key — the secret is shown once.
3. Store them: pipe the lines `AWS_ACCESS_KEY_ID=<id>` and `AWS_SECRET_ACCESS_KEY=<secret>` into `flow credentials set aws --stdin`.
4. Confirm with `flow credentials check aws`. Never print or repeat the secret.
