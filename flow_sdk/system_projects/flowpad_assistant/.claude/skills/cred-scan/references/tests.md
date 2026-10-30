# A credential's `test` — are the values GOOD, not only present

`credential.json` may carry `test`: a read-only call that proves the provider takes
the values. Without one, a dead key reads as "Connected" (a value is present).
With one, the Test button, `flow credentials test <name>` and `flow credentials
check <name>` (so every setup step) run it.

## The contract

```json
"test": {"commands": {
  "darwin": "curl -fsS -o /dev/null -H \"Authorization: Bearer $BRIGHT_DATA_API\" https://api.brightdata.com/zone/get_active_zones",
  "linux":  "curl -fsS -o /dev/null -H \"Authorization: Bearer $BRIGHT_DATA_API\" https://api.brightdata.com/zone/get_active_zones",
  "win32":  "curl.exe -fsS -o NUL -H \"Authorization: Bearer %BRIGHT_DATA_API%\" https://api.brightdata.com/zone/get_active_zones"
}}
```

- It runs with the credential's values in its environment (`$VAR` / `%VAR%`),
  and the credential's own folder as the working folder.
- **Exit 0 = the values work; any other exit = rejected.** `curl -f` turns a
  4xx/5xx into exit 22. Its first stderr line becomes the reason (values scrubbed).
- **Read-only.** A GET that lists or describes the account (models, zones, the
  account itself). Never one that creates, sends, charges or changes anything.
- **Prints no value.** `-o /dev/null`; never `echo $VAR`, never `-v`.
- **Cheap and fast**: it runs on every Test click and every setup check.
- Logic that does not fit one line goes in `test.py` beside `credential.json`
  (stdlib only, reads `os.environ`, `sys.exit(0|1)`); the command is then
  `python3 test.py` (`python test.py` on win32).

## Known endpoints

| Provider | Variable | Test request (all GET) |
| --- | --- | --- |
| Bright Data | `BRIGHT_DATA_API` | `https://api.brightdata.com/zone/get_active_zones`, `Authorization: Bearer` |
| OpenAI | `OPENAI_API_KEY` | `https://api.openai.com/v1/models`, `Authorization: Bearer` |
| Anthropic | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1/models`, `x-api-key` + `anthropic-version: 2023-06-01` |
| OpenRouter | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1/key`, `Authorization: Bearer` |
| Groq | `GROQ_API_KEY` | `https://api.groq.com/openai/v1/models`, `Authorization: Bearer` |
| GitHub token | `GH_TOKEN` | `https://api.github.com/user`, `Authorization: Bearer` |
| Twilio | `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` | `https://api.twilio.com/2010-04-01/Accounts/$SID.json`, basic auth `-u $SID:$TOKEN` |
| SendGrid | `SENDGRID_API_KEY` | `https://api.sendgrid.com/v3/scopes`, `Authorization: Bearer` |

Not listed: read the provider's API docs (from `help_url`, or the code that
uses the variable) for its cheapest authenticated GET.
