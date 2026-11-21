---
id: f36def6e-9472-48b2-aedd-dd130ac34c45
title: System-prompt layers
tags:
- flow.agents.system_prompt
---
# System-prompt layers

A worker's standing instructions are ONE text, composed in ONE place:
`flow_sdk/builtin/agentic_process/system_prompt.py` (`compose_layers` + `render`),
called from `ProcessAssets._prepare_system_instruction_assets` on every turn path —
headless driver, inline print-mode, and PTY launch. Nothing else adds standing text:
a new standing instruction is a new `LayerKey`, never a driver side channel and never
text pasted into the user's prompt.

## Order and scope

Most general first. A layer is present only when its scope applies and it has text.

| # | `LayerKey` | Source | Applies to |
|---|---|---|---|
| 1 | `COMMON` | `system_projects/flowpad_assistant/instructions/common.md` | every process — SDK, CLI, backend, app |
| 2 | `COMMON_UI` | `…/instructions/common_ui.md` | `context_data.launch_surface == "app"` |
| 3 | `INSTRUCTIONS` | `context_data.instructions` | the agent's `system_prompt` (`Deployment.create_process`), a task brief, the assistant chat's page context, any caller |
| 4 | `IO` | `context_data.io_instructions` | typed runs (`process_io.prepare_io`) |
| 5 | `ALWAYS_USE_SKILLS` | the project's `always_use_skills` | projects that declare them |
| 6 | `COS_TASKS` | `tasks/cos.open_tasks_block` | Chief of Staff — rebuilt every turn |
| 7 | `AGENTS` | embedded agents: persona (`process_persona_path`) + layers | sessions with embedded sub-agents (vibe.md, standard.md, wizards…); suppressed for a CoS |
| 8 | `AUTO_OPEN` | `agent_auto_open.auto_open_prompt_block` | sessions with `vibe` embedded |
| 9 | `LANGUAGE` | `i18n.supported_locales.language_prompt_block` | the project has a non-English `locale` |
| 10 | `BROWSER` | the session's browser driver, `agentic-assets/browser_driver/<name>/instructions.md` (`BrowserLaunch.instructions`) | every session — it always has a browser |
| 11 | `CREDENTIALS` | `cli_worker_base_driver.credentials_prompt_block` — the project's credentials by name, never a value | projects that declare a credential |
| 12 | `SECRET_MANAGER` | the active vault's manager, `agentic-assets/secret_manager/<name>/instructions.md` filled with the vault's config (`managers.instructions_for`) | a vault is active for the project (`secrets/active.py`) |
| 13 | `SUBJECT` | `system_prompt.subject_layer` | app chats keyed to a local file (`target_typeid_str` = `compute_node-@local/<path>`, "Chat about this file") |

`common.md` / `common_ui.md` ship with the wheel (the `system_projects/**/*`
package-data glob). Their frontmatter (`id`, `title`) is stripped; a missing or empty
file is no layer. `SystemInstructionAssets.layers` records which layers a launch got.

## Layers a selected asset renders

`BROWSER` and `SECRET_MANAGER` are not fixed text: each is rendered by the ONE asset selected for
the session, and both are selected by the same ladder — the person's own pick for the project on
this computer, then the session / entity, then the project, then the default.

| | Browser | Secret vault |
|---|---|---|
| asset | `BrowserDriver` (`agentic-assets/browser_driver/<name>/`) | `SecretManager` (`agentic-assets/secret_manager/<name>/`); a vault is one configured instance |
| rule | `browser_choice.decide` | `secrets/active.active_among` |
| the person's pick | `preferences.browser.pick.<project id>` | `preferences.secrets.vault_pick.<project id>` |
| shown and changed in | the footer's browser menu | the footer's key menu |

The pick is saved on the instance, never in the project: `project_manifest.json`'s `browser` is a
recommendation, and `default_secret_vault` stays the team's default. Composing a prompt runs no
manager command and opens no browser. The browser is decided once per launch
(`ProcessAssets.prepare_process_assets`) and handed to both the composer and the launch switches,
so the prompt cannot name a browser the session did not get. A driver that does not support the
session's worker is replaced by the default one before either reads it ([browser-drivers](../browser-drivers.md)). A vault can change mid-session while
a PTY session's prompt is written at launch: `flow secrets active` is the live answer.

## The app stamp — `launch_surface`

The Flowpad app calls `setLaunchSurface('app')` once at boot (`ui/src/main.tsx`). From
then on every process-creating call the TS SDK makes carries `launch_surface: "app"`:

* `createProcess` — `serializeAgenticContext` (`ts_sdk/src/process/agentic-context.ts`)
* `Agent.use` / `Agent.useDeployment` — the `use` body → `Agent.use_action` → `Deployment.use`
* the agent auto-launch — `POST /api/v1/agents/auto-launch` → `Agent.auto_launch_for`
* a session adopted into a terminal — `AgenticProcess.getByWorkerId` (query hint)

The backend turns it into `context_data.launch_surface` through
`system_prompt.launch_surface_options` (any value but `"app"` is ignored). A TS SDK
script never calls the setter, so its processes are not app launches.

A session opened on a REMOTE placement goes through the hub (`Deployment._use_on_hub`
→ hub `Agent.use_action` → `DeployedAgent.open_session`), which forwards `"app"` to the
machine's `use` (hub tests `unit/test_deployed_agent_launch_surface.py` and the real-box
`long_tests/test_deployed_agent_local.py`). App clicks that start BACKEND-run work (an
agent's `run`, setup runs, wizard steps) are backend launches: `common.md` only.

## How each vendor receives the text

`driver.prepare_instruction_assets` writes the rendered text; the vendor reads it:

| Vendor | Channel |
|---|---|
| claude | `--append-system-prompt-file <assets>/CLAUDE.md` |
| codex | `-c developer_instructions=<text>` |
| copilot | `COPILOT_CUSTOM_INSTRUCTIONS_DIRS=<assets>` → `.github/instructions/flowpad.instructions.md` |
| opencode | `OPENCODE_CONFIG` → generated `opencode.json` `instructions` |
| deepagents | `--system-prompt-file <assets>/CLAUDE.md` |

## Proof

`tests/unit/system_prompt_matrix/test_system_prompt_matrix.py` — every launch way ×
every vendor × every turn path that vendor supports, asserting the exact ordered
layers in the vendor's real channel. Its coverage guards fail when a vendor, a layer
or a process-creation site appears without a row. `ui/tests/unit/launch-surface.test.ts`
pins the TS seam.
