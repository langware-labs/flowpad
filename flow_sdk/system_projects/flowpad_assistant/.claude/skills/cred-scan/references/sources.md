# Where credentials hide — and what each place proves

Strongest evidence first. "Script" means `cred_scan.py scan` covers it; "sweep"
means phase 1's judgment sweep reads it by hand.

| # | Source | Examples | Proves | Covered by |
| --- | --- | --- | --- | --- |
| 1 | Settings schemas | pydantic `BaseSettings`, zod / `@t3-oss/env` `createEnv`, Prisma `env("X")` | the author's own required/optional + defaults — the best tier evidence | script (pydantic, zod, prisma); sweep for envalid, joi, convict, decouple, Spring `@Value`, Rails credentials |
| 2 | Code reads | `os.environ["X"]`, `getenv("X", d)`, `process.env.X!`, `?? d`, `ENV.fetch`, `env::var(..).unwrap()`, `os.Getenv`, `System.getenv` | how the program behaves when unset: fail (`hard`), fallback (`default`), or silent `None` (`read`) | script, per line; sweep for reads through an alias or dict |
| 3 | Env templates | `.env.example`, `.sample`, `.template`, `.dist`, `.defaults`, `example.env` | the documented list; commented = optional; the comment above a key is its hint | script (comments kept as `note`) |
| 4 | Infra | docker-compose `${X:?}` / `${X:-d}` / `environment:`; Dockerfile `ARG`/`ENV`; Terraform `variable` (no default = required, `sensitive`) | what the deployed shape demands | script |
| 5 | Docs | README, CONTRIBUTING, `docs/` setup sections | where to obtain a value (`help_url`, `setup`) and human "required" statements | sweep |
| 6 | SDK dependencies | `openai`, `boto3`, `stripe`, `@sentry/*` … in package.json / requirements / pyproject / go.mod / Gemfile / Cargo.toml | a var nobody names in code because the SDK reads it itself | script (`references/sdk-implicit.md`); sweep confirms the client is built |
| 7 | CI / CD | `${{ secrets.X }}`, `env:` in GitHub Actions, GitLab, CircleCI, Bitbucket, Jenkins | needed by tests (`ci-test`) or only to ship (`ci-deploy`) | script |
| 8 | Tests | `skipif(not getenv("X"))`, jest / vitest / playwright config, `conftest.py` | optional for running, required for that suite | script (`test`, `test-skip`) |
| 9 | Scripts | Makefile, justfile, Procfile, `*.sh` `${X:?}` | what a dev or deploy task needs | script |
| 10 | Real env files | `.env`, `.env.local`, `.env.<mode>`, `.envrc`, `.flaskenv` | someone set it — undocumented if the template lacks it | script (keys only) + `declared` (the backend's own detector) |
| 11 | Credential files | `*.pem`, `*.key`, service-account JSON, `.npmrc _authToken=${X}`, `.pypirc`, `.netrc` | a file-shaped credential — declare the PATH var (`GOOGLE_APPLICATION_CREDENTIALS`), never the file | script (`credential_files`) |
| 12 | Agent configs | `.mcp.json`, `.claude/settings*.json` `env`, `agentic-assets/**/agent.json`, `data_source.json` | keys an agent or a tool server needs | sweep |
| 13 | Hardcoded secrets | `sk-…`, `ghp_…`, `AKIA…`, `xox…`, `sk_live_…`, `AIza…`, private-key blocks, `scheme://user:pass@host` | a leak to move into a credential and rotate | script (`alerts`, kind + file:line only) |

What a source does NOT prove:

- An `sdk` row proves a dependency, not a use.
- `present` proves a machine had it, not that the app needs it.
- `template-value` is an example, not a default the app applies.
- A CI secret named like an app var may be for a different job — check the job.
