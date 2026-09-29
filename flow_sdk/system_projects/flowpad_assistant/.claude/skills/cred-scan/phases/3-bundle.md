# Phase 3 · Bundle, declare, index

> **Ground rules (inline by design, repeated in every phase file):**
> **1. Names and places, never values.** A value is never printed, quoted, written
> into a manifest or a report. Env files are read for their keys only. A leaked
> secret is reported as file:line and kind.
> **2. Evidence before tier.** Every tier and every bundle cites the file:line that
> earned it; a guess is labelled a guess.
> **3. The user approves before anything is written.** Phase 2 ends at a review
> table; phase 3 starts only on their go.
> **4. Re-running converges.** A credential is found by name and updated in place,
> never declared twice.

Goal: every MUST and USEFUL variable belongs to exactly one declared, indexed
Credential. EXTRA is reported, never declared.

## 1. Cluster into bundles

One bundle = one thing a person signs up for or configures once. Group by, in
order:

1. **A shipped template** — if the vars match one, the bundle IS that template:
   same `name`, and copy its fields (`title`, `icon_name`, `help_url`,
   `lm_provider`, per-var `label`/`hint`/`pattern`). Templates live beside this
   skill's project in `agentic-assets/credential/` (`openai`, `anthropic-key`,
   `openrouter`, `gmail`, `twilio`) and in each data driver's own
   `agentic-assets/credential/` (`jira`, `telegram`, `whatsapp`).
2. **A service** — the SDK row, or the shared prefix (`STRIPE_*`, `AWS_*`,
   `SUPABASE_*`). Mirrors (`VITE_X`, `NEXT_PUBLIC_X`) join the bundle of `X`.
3. **The app itself** — MUST config and secrets that belong to no service
   (`DATABASE_URL`, `SESSION_SECRET`) go into `<project>-app`.

An LLM key bundle holds exactly one var and sets `lm_provider` (the spec refuses
otherwise), and it is never declared in the project: a provider key funds every
project, so declare refuses it with *"can only be added for the user"*. When a
shipped template covers it (`openai`, `anthropic-key`, `openrouter`), report the
bundle as covered by that template — it enters the user's credentials the moment
the user sets its value (`flow credentials set <name> --stdin`, or *Set values*). Skip every var the `declared` output already covers in this project
or the user's scope — the save refuses a var two credentials in one scope both
claim.

## 2. Write one manifest per bundle

In a scratch folder — never inside `agentic-assets/` (declare refuses a folder
that already exists):

```json
{
  "schema": 2,
  "name": "stripe",
  "title": "Stripe",
  "description": "Stripe API keys for payments and webhooks.",
  "icon_name": "CreditCard",
  "help_url": "https://dashboard.stripe.com/apikeys",
  "vars": {
    "STRIPE_API_KEY": {"label": "Secret key", "placeholder": "sk_test_…", "required": "MUST"},
    "STRIPE_WEBHOOK_SECRET": {"label": "Webhook signing secret", "required": "OPTIONAL",
                              "hint": "Only for receiving webhooks — app/hooks.py."}
  },
  "setup": "## Stripe\n\n1. Open https://dashboard.stripe.com/apikeys (Developers → API keys) and sign in.\n2. Under *Secret key*, reveal and copy it into STRIPE_SECRET_KEY — use the test-mode key for development.\n3. Only to receive webhooks: Developers → Webhooks → your endpoint → *Signing secret* → STRIPE_WEBHOOK_SECRET."
}
```

Field rules (`flow_sdk/schema/data_spec/credential_spec.py`):

- `name` — kebab-case, `^[A-Za-z0-9][A-Za-z0-9_.-]*$`; the folder name.
- per var: `required` is the tier as saved — `"MUST"` for MUST, `"OPTIONAL"` for
  USEFUL (it defaults to `"MUST"`, so write `"OPTIONAL"` explicitly). The
  Connections table and the credential editor chip it, so the tier survives the
  run. `secret` defaults true — set `false` for account ids and config;
  `account_key: true` for account ids; `advanced: true` for deploy-only;
  `pattern` only when you know the real shape.
- `setup` is required: how to obtain each value, from the docs you read in phase
  1 — which console, which page, which button. No values, no example secrets.
- Never put a value, a default secret, or a `value_store` in the manifest.

## 3. Declare — this writes the folder AND indexes the row

From the project root, per manifest:

```bash
flow credentials declare "$TMPDIR/cred-scan/stripe.json"
```

It validates the manifest, writes `agentic-assets/credential/<name>/`
(`credential.json` + `setup.md`) and indexes the row with its scope and project
— one call is the whole write. Declaring a name the project already has updates
it in place. A refusal names the problem (a clashing var, a bad name) — fix the
manifest and re-run.

Declare is the only write path. A hand-written folder, or a generic re-index
(`flow record index`) over one, re-derives the row's scope and project from the
path instead of from the declaration, and a project credential can come back
filed under the wrong project or as the user's.

## 4. Verify, then show

For every bundle: `flow credentials check <name>` must report `"declared": true`.
Exit 1 with `"ready": false` is expected — no values are set yet — and the
`missing` list is exactly what the user fills next.

Show the result with `flow show view assets/list/credential` (the
`flowpad-navigation` skill owns presenting), and end with:

- the bundles declared, each with its MUST / USEFUL vars;
- EXTRA vars, as names, and where they are read;
- every alert, with the fix: move the literal into its credential and rotate it;
- the next step, which is the user's: *Set values* on each credential, or
  `flow project setup` to walk them through it.
