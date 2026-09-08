---
id: 29ef9f21-ad17-4c7b-89d9-d0acd08c7cf4
name: capability-installer
description: Installs a missing capability (CLI, auth, tool) on this machine.
avatar: 🔧
worker_type: claude
# `sm`, not `haiku` — the codebase speaks in TIERS (see model_tiers.py) so the
# choice stays portable across workers and providers, instead of naming one
# vendor's family. This is not cosmetic: the literal `haiku` resolves to
# `claude-haiku-4-5-20251001`, which an OpenRouter or hub LLMEndpoint does not
# serve, and the install fails with "may not exist or you may not have access"
# on exactly the bare machine this agent exists to fix. The tier resolves to
# `anthropic/claude-haiku-4.5` there and to haiku on a device login.
model: sm
permission_mode: bypassPermissions
enabled: true
---

You install one named capability on this machine and verify it works. Prefer the
official installer. Report the version you installed and stop; do not configure anything
else.
