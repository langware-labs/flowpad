# Phase 1 · Scan

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

Goal: one inventory of every variable the project reads, each with the evidence
of HOW it is read — that "how" is what phase 2 turns into a tier.

## 1. Run the inventory

From the project root:

```bash
python3 <skill>/scripts/cred_scan.py scan . > "$TMPDIR/cred-scan.json"
python3 <skill>/scripts/cred_scan.py declared > "$TMPDIR/cred-declared.json"
```

`scan` walks the tree (skipping dependency, build and cache folders, minified
bundles and nested repositories — pass `--include-nested` for a monorepo whose
packages are their own git repos) and prints:

```json
{"vars": [{"name": "STRIPE_API_KEY", "sources": ["code", "env-template"],
           "signals": ["hard", "template"],
           "evidence": [{"file": "app/pay.py", "line": 12, "source": "code", "signal": "hard"}]}],
 "sdks": [{"service": "stripe", "vars": ["STRIPE_API_KEY"], "help_url": "…", "evidence": […]}],
 "credential_files": [{"file": "deploy/sa.json", "kind": "service-account"}],
 "alerts": [{"file": "scripts/seed.py", "line": 4, "kind": "openai-key"}]}
```

`declared` is what this project and the user already declare (names, scopes,
vars) plus the keys the backend found in each scope's env file. It needs the
Flowpad CLI environment; if it fails, say so and carry on — phase 3 re-checks
before writing anything.

The signal vocabulary is in the script's docstring; `references/sources.md` says
what each source proves.

## 2. The judgment sweep — what no regex can see

Read, don't grep blindly. For each, add rows to your working inventory with the
file:line you read them from — the same shape as the script's evidence, with
`source` naming what you read and `signal` from the script's vocabulary:

```json
{"name": "STRIPE_SECRET_KEY", "evidence": [
  {"file": "README.md", "line": 14, "source": "docs", "signal": "hard",
   "note": "setup section says the app will not start without it; key at dashboard.stripe.com/apikeys"}]}
```

- **README / CONTRIBUTING / docs setup sections** — "export X=…", "you need an API
  key from …", "copy .env.example". This is where `help_url` and the `setup` text
  come from, and a human sentence saying a var is required outranks a guess.
- **Settings code the script only half-sees** — a config class that maps names
  through a prefix, an alias or a dict (`env.str("X")`, `config("X")` with
  python-decouple, Spring `@Value("${x.y}")`, Rails `credentials.yml.enc` keys).
- **How a `read` is used** — a `read` with no default whose value flows straight
  into a client constructor on startup is effectively `hard`. Open the line and
  note it.
- **Agent and tool configs** — `.mcp.json`, `.claude/settings*.json` `env`,
  Flowpad `agentic-assets/**/agent.json` and `data_source.json`.
- **SDK rows** — an entry in `sdks` means the dependency is installed, not that
  it is used. Confirm a client is constructed (and whether the key is passed
  explicitly, which makes the SDK default irrelevant).

## 3. Hand-off

Keep the inventory (script JSON + your sweep rows) for phase 2. Do not print the
env files, and do not open a file named in `alerts` to "check" the secret — the
file:line is the whole report.
