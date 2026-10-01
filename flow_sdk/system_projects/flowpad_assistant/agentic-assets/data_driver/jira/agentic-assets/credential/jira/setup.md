Create a Jira API token and store it with the account's email.
1. Ask the person which Atlassian account to use; it must be able to see the issues the source will read.
2. Open https://id.atlassian.com/manage-profile/security/api-tokens, choose "Create API token", name it "Flowpad", and copy the token.
3. Store both: pipe the lines `JIRA_EMAIL=<account email>` and `JIRA_API_TOKEN=<token>` into `flow credentials set jira --stdin`.
4. Confirm with `flow credentials check jira`. Never print or repeat the token.
