# Phase 2 · Classify

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

Goal: every inventoried variable gets exactly one tier, one kind, and the
evidence that decided it.

## 1. Drop what is not the project's to supply

Remove variables the runtime or the platform sets (the script already drops
`PATH`, `HOME`, `CI`, `NODE_ENV`, `GITHUB_*`…), build-tool internals, and names
that only appear in vendored code. Say how many you dropped and why, in one line.

## 2. Tier — the strongest evidence wins

Two tiers are saved on the credential as its `required` (phase 3): MUST as
`"MUST"`, USEFUL as `"OPTIONAL"`. EXTRA stays in the report.

| Tier | Meaning | Evidence that puts a var here |
| --- | --- | --- |
| **MUST** | The app will not start or its core path fails without it | `hard` · `schema` · `infra-hard` · `template` (empty, uncommented) · a `read` that feeds a client built at startup · an `sdk` var for a client the main path constructs · docs saying "required" |
| **USEFUL** | Important but optional — a feature, an integration, deploy or test coverage turns on | `default` / `read` behind a guard or feature flag · `optional` (commented in a template) · `test-skip` · `ci-test` · `ci-deploy` · `schema-default` for a secret-shaped name · `present` only (someone set it; nothing documents it) |
| **EXTRA** | Expert tuning with a sane default | log levels, timeouts, retries, pool and batch sizes, ports, debug and trace flags, model/temperature knobs — anything `default` / `schema-default` / `template-value` that is not a secret |

Precedence when evidence disagrees: **schema › hard read › infra-hard ›
template › docs › CI › test** — take the tier of the strongest and note the
conflict in the row (`hard in app/db.py:9, but tests skip without it`). The order
is how directly each source states the program's behaviour: a schema and a hard
read ARE the behaviour (the process refuses to start); infra and templates are the
author's declared intent for running it; docs may be stale; CI and tests describe
one job's needs, not the app's.

A deploy-only secret (`ci-deploy`, Terraform) is USEFUL, marked **advanced** —
the app runs locally without it.

## 3. Kind — secret, account id, or config

- **secret** — the name carries `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASS`,
  `PRIVATE`, `DSN`, `CREDENTIALS`, `AUTH`, or it is a URL that embeds a
  password (`DATABASE_URL`, `REDIS_URL` with userinfo).
- **account id** — names the remote account, not a secret: `*_ACCOUNT_SID`,
  `*_ADDRESS`, `*_USERNAME`, `*_CLIENT_ID`, `*_PROJECT_ID`, region. Declared with
  `secret: false, account_key: true`.
- **config** — everything else. A MUST config item (a required base URL, a
  tenant name) is still declared, with `secret: false`; EXTRA config is not.

## 4. The review table — then stop

Show exactly this shape, MUST first, then USEFUL, then EXTRA collapsed to names:

```
| Var | Tier | Kind | Bundle | Evidence |
| --- | --- | --- | --- | --- |
| STRIPE_API_KEY | MUST | secret | stripe | app/pay.py:12 hard · .env.example:4 |
| STRIPE_WEBHOOK_SECRET | USEFUL | secret | stripe | app/hooks.py:8 default |
| SENTRY_DSN | USEFUL | secret | sentry | requirements.txt:9 sdk · settings.py:40 read |
| DATABASE_URL | MUST | secret | myapp-db | prisma/schema.prisma:7 schema |

Needed for: stripe — charges cards at checkout · sentry — reports crashes · myapp-db — stores every order
EXTRA (not declared): LOG_LEVEL, REQUEST_TIMEOUT, WORKERS
Already declared (skipped): OPENAI_API_KEY → openai (user)
Alerts: scripts/seed.py:4 openai-key — move it into the credential, rotate the key
```

The **Bundle** column is phase 3's proposal (see `phases/3-bundle.md` §1), shown
now so the user approves the grouping and the tiers in one look. The **Needed
for** line is each bundle's `needed_for` as phase 3 will write it — what the
project does with it, from the evidence — so the user corrects the wording here.

Ask one question: *declare these bundles?* — and wait. Edits to a tier or a
bundle are applied to the table and shown again. `cred-scan report` ends here.
