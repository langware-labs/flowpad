# agent-trace — learnings

Accumulated non-obvious knowledge for the agent-trace skill. Append new
learnings at the bottom; keep each one a single dated bullet.

- 2026-06-12: Skeletons for team sessions (e2e-qa) reach 8MB+ with 70+ lanes —
  always `jq`-filter, never Read the raw skeleton; reading it will blow the
  context window.
- 2026-06-12: `summary.cost_usd` sums root + every subagent transcript at list
  price; treat it as an upper bound, not billing truth.
- 2026-06-12: Some older `agent-*.meta.json` files lack `toolUseId` — those
  lanes still build, but `spawn_tool_use_id` is null and the spawn call site
  can't be linked. Don't treat that as an error.

- 2026-06-12: Claude Bash tool results carry NO exitCode — failure signal is the
  result block's is_error, which _fold_tool_results now preserves onto the call
  entry. If a trace shows issues=0 on a session full of failing tests, the
  manager likely piped through tee/tail (exit 0) — that's a skill-instruction
  gap (pipefail), not a synthesizer bug.
- 2026-06-12: The entity 'trace' field is a JSON STRING (blob storage is
  string-only) — payload jq must use 'trace: (. | tostring)'. Backend must be
  restarted (or reloaded) after first adding the type; watchfiles 'change
  detected' lines do not imply a reload happened.

- 2026-06-12: Codex cost validation — do NOT trust ccusage as the codex
  reference: it double-counts old-format rollouts (every token_count event is
  written twice) and guesses rates when the model isn't where it looks (priced
  a gpt-5.5 session at gpt-5.3-codex rates). Ground truth = the rollout's own
  cumulative total_token_usage counter × per-file model rates. Our parser now
  bills cumulative increments (reset-aware) with non-overlapping dims (codex
  input INCLUDES cached; output INCLUDES reasoning); validated 0.00% across 10
  sessions / 4 models (gpt-5.5, 5.4, 5.3-codex, 5.2-codex).

- 2026-06-25: A 404 `No claude transcript JSONL found` can be correct, not a
  bug. If the session id resolves to a live *interactive* Claude process
  (`ps aux | grep <sid>` shows `--session-id <sid>` WITHOUT `-p` and no prompt),
  it's an idle REPL that never took a turn → no projects/*.jsonl written yet.
  Verify with `find ~/.claude/projects -name '<sid>*.jsonl'` (empty) and
  `lsof -p <pid> | grep jsonl` (no open transcript). Do NOT fabricate a trace —
  report "no execution to analyze" and stop. Confirm the endpoint itself is fine
  by skeleton-ing a known-good session first.
