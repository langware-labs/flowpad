---
id: 249ca7d7-1f8e-5a96-8fd1-43506780e28f
---

## 2026-06-07 log

- The `e2e-qa` skill depends on Claude-specific orchestration primitives (`TeamCreate`, `TaskCreate`, `SendMessage`, and `Skill(skill="loop")`) without a fallback path for Codex or plain shell execution. Running it here required manually executing the phases and maintaining state outside those tools.
- The run-integrity guidance says shared services must be launched as daemons, but the phase examples still use background shell commands such as `uv run -m flow_sdk.server.run &`. That is ambiguous for non-interactive runs where child processes can be cleaned up with the shell session.
- The skill says to avoid hardcoded ports, but some command examples embed `localhost:${LOCAL_SERVER_PORT}` / `localhost:${VITE_PORT}` URL forms directly instead of consistently using resolved `API_URL` and `APP_URL` variables.
- The watchdog step requires `Skill(skill="loop")`, but the skill does not describe how to verify that the loop skill is available or what to do when it is not.
- The Phase 8 Playwright command exports only `VITE_PORT`, but multiple shipped `.md.ts` tests read `API_URL` and/or `QA_API_URL` and otherwise fall back to stale hardcoded ports like `6002`/`6003`. The skill should include `API_URL="http://localhost:${LOCAL_SERVER_PORT}"` and `QA_API_URL="${API_URL}"` in the Phase 8 command, matching its own environment rule.
- Phase 11 says to launch `dev-1` and `dev-2` with `instance_ctl`, but it does not require a post-launch stability check before starting `npm run test:vitest:hub`. In this run, `instance_ctl` reported the instances up, but the detached backends became unreachable before/during collection; running the backends in live foreground sessions was needed to separate launcher instability from the real hub fanout failure. The phase should explicitly verify both generated env files, distinct frontend ports, and live backend bootstrap immediately before the suite.
