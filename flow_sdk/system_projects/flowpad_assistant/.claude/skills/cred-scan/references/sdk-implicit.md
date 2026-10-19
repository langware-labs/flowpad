# SDKs that read credentials on their own

A client built without an explicit key falls back to these variables. The
script's `SDK_IMPLICIT` table is the machine copy of this page — change both
together (`tests/unit/test_cred_scan_script.py` checks every service here is
there too).

| Service | Dependency tokens | Variables | Get them at |
| --- | --- | --- | --- |
| openai | `openai` | `OPENAI_API_KEY` | https://platform.openai.com/api-keys |
| anthropic | `anthropic`, `@anthropic-ai/sdk` | `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys |
| gemini | `google-generativeai`, `@google/generative-ai` | `GOOGLE_API_KEY` | https://aistudio.google.com/app/apikey |
| mistral | `mistralai` | `MISTRAL_API_KEY` | https://console.mistral.ai/api-keys |
| cohere | `cohere` | `CO_API_KEY` | https://dashboard.cohere.com/api-keys |
| groq | `groq` | `GROQ_API_KEY` | https://console.groq.com/keys |
| aws | `boto3`, `aws-sdk`, `@aws-sdk/*`, `aws-sdk-go` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` (or `AWS_PROFILE`) | https://console.aws.amazon.com/iam/ |
| gcp | `google-cloud-*`, `@google-cloud/*` | `GOOGLE_APPLICATION_CREDENTIALS` (a service-account JSON — declare it `"kind": "file"`) | https://console.cloud.google.com/iam-admin/serviceaccounts |
| firebase | `firebase-admin` | `GOOGLE_APPLICATION_CREDENTIALS` | https://console.firebase.google.com/ |
| azure | `azure-identity`, `@azure/identity` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET` | https://portal.azure.com/ |
| stripe | `stripe` | `STRIPE_API_KEY` (the library reads none by default — most code passes `STRIPE_SECRET_KEY`; check the call) | https://dashboard.stripe.com/apikeys |
| twilio | `twilio` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | https://console.twilio.com/ |
| sendgrid | `sendgrid`, `@sendgrid/mail` | `SENDGRID_API_KEY` | https://app.sendgrid.com/settings/api_keys |
| resend | `resend` | `RESEND_API_KEY` | https://resend.com/api-keys |
| sentry | `sentry-sdk`, `@sentry/*` | `SENTRY_DSN` | https://sentry.io/settings/projects/ |
| slack | `slack_sdk`, `@slack/web-api`, `@slack/bolt` | `SLACK_BOT_TOKEN` (+ `SLACK_SIGNING_SECRET` for bolt) | https://api.slack.com/apps |
| supabase | `supabase`, `@supabase/supabase-js` | `SUPABASE_URL`, `SUPABASE_KEY` / `SUPABASE_ANON_KEY` | https://supabase.com/dashboard/project/_/settings/api |
| pinecone | `pinecone`, `@pinecone-database/pinecone` | `PINECONE_API_KEY` | https://app.pinecone.io/ |
| huggingface | `huggingface_hub` | `HF_TOKEN` | https://huggingface.co/settings/tokens |
| replicate | `replicate` | `REPLICATE_API_TOKEN` | https://replicate.com/account/api-tokens |
| langsmith | `langsmith` | `LANGSMITH_API_KEY` | https://smith.langchain.com/settings |
| e2b | `e2b` | `E2B_API_KEY` | https://e2b.dev/dashboard |
| github | `PyGithub`, `@octokit/rest` | `GITHUB_TOKEN` | https://github.com/settings/tokens |

Using a row:

- The code passes the key explicitly (`OpenAI(api_key=settings.x)`) → the SDK
  default is irrelevant; the variable that feeds `settings.x` is the one to declare.
- Several SDKs from one vendor (`@aws-sdk/client-s3` + `@aws-sdk/client-sqs`) →
  one bundle.
- A local-only alternative exists (`AWS_PROFILE`, `gcloud auth
  application-default login`) → keep the vars USEFUL and say so in `setup`.
