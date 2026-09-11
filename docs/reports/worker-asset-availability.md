# Worker asset availability validation

Date: 2026-09-10. Status: implementation in progress; full live-worker parity is not yet certified.

The original UI treated unused catalog entries as available. A file being indexed does not establish that the selected worker discovers or enables it.

## Evidence gathered

Native initialization probes covered Claude, Codex, Copilot and OpenCode, with headless and PTY launch configuration, and vibe, standard, advanced and dev modes: 32 combinations. Each probe used distinct skill and agent fixtures in the four vendor directories, both in the working directory and an added directory. No LLM turn was sent. These probes inspect fresh native discovery; they are not captures of 32 live conversations.

| Worker | Project skills observed | Added-directory skills observed | File agents observed |
| --- | --- | --- | --- |
| Claude | `.claude/skills` | `.claude/skills` | project `.claude/agents`; mounted agents absent |
| Codex | `.agents/skills` | none | no Markdown agents |
| Copilot | `.github`, `.agents`, `.claude` skills | `.github/skills` | project `.github` and `.claude` agents; SDK omits mounted agents |
| OpenCode | `.opencode`, `.agents`, `.claude` skills | all four projected skill roots | project `.opencode/agents` |

Successful fixture results agreed across modes and transport configurations. Copilot's pinned and updating executable paths reported different versions, 1.0.82 and 1.0.83; inventory launch now follows the worker's updater setting.

## Implemented corrections

- Process availability joins native observations to catalog identity. Catalog-only executable assets are removed; recorded usage remains visible independently.
- Native plugin and unindexed file assets can appear without an index row. Native invocation names have a separate descriptor field, preserving plugin namespaces over cached display labels.
- Assistant drill-down filters through the worker inventory. Pre-launch catalogs are labelled “Project assets”.
- Verification failures are explicit and preserve recorded usage. They do not imply an empty native inventory.
- Assistant enablement comes from the backend's resolved setting, including the global default. The toggle no longer assumes inheritance means enabled.
- Live PTY inventory inspection uses saved worker configuration and mount directories; headless next-turn inspection uses current configuration. Old pending-restart records without a snapshot remain unverified.
- OpenCode's large inventory output is captured through a regular file. Its native output was truncated when written to a pipe.
- OpenCode inventory commands and requests are serialized: concurrent initialization caused `database is locked`. All eight OpenCode combinations returned inventories after serialization. No timeout or retry budget was increased.

## Current checks

- 116 targeted backend tests passed, covering reconciliation, native transport, discovery roots, launch snapshots and driver contracts.
- Five assistant-popover tests passed, including worker filtering and verification-error rendering.
- Three React hook tests passed against the disposable-instance test setup, including inherited assistant disablement and preserving usage on verification failure.
- UI typecheck: zero errors. Ruff passed on the changed reconciliation module and tests.

## Remaining completion gates

1. Copilot's SDK omits added-directory agents that a real interactive CLI launch successfully selected without an LLM turn. Mounted-agent cases currently report verification unavailable. Find an equivalent native inspection path before claiming parity.
2. Complete launch-snapshot coverage for derived instruction assets and configuration changes; verify against actual running workers. Fresh discovery cannot establish what a long-running CLI cached before a file edit.
3. OpenCode duplicate skill names can resolve to different physical copies between separate probes. Logical-name agreement does not certify file attribution.
4. Verify instruction, persona and MCP injection, mode-specific restrictions, and final rendered UI against the actual worker inventory.

Changes are uncommitted and have not been released. This report distinguishes passing checks from the outstanding gates; it is not a completion certificate.
