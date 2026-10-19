Store the signing secret of the OpenAI webhook that rings the phone line.
1. Open https://platform.openai.com/settings/project/webhooks in the OpenAI project the line uses.
2. Open the endpoint that receives `realtime.call.incoming` (create it if there is none) and copy its signing secret (`whsec_…`).
3. Store it: pipe the line `OPENAI_WEBHOOK_SECRET=<secret>` into `flow credentials set openai-webhook --stdin`.
4. Confirm with `flow credentials check openai-webhook`. Never print or repeat the secret.
