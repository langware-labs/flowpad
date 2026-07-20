---
id: ca5731e8-62ef-4313-8594-865523689f6c
title: Install a harness
---

# Install a harness

A **harness** is the coding-agent CLI that Flowpad drives to run agents, skills and conversations. Flowpad supports three: **Claude Code** (the default), **Codex CLI** and **Copilot CLI**. At least one must be installed on this machine — pick one below, run the install command in a terminal, and you're set.

## Claude Code (recommended)

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Or via npm: `npm install -g @anthropic-ai/claude-code` (needs Node 18+).

Verify with `claude --version`. Official guide: [code.claude.com/docs/en/setup](https://code.claude.com/docs/en/setup)

## Codex CLI

```bash
npm i -g @openai/codex
```

Or via Homebrew: `brew install codex`.

Verify with `codex --version`. Official guide: [developers.openai.com/codex/cli](https://developers.openai.com/codex/cli)

## Copilot CLI

```bash
npm install -g @github/copilot
```

Needs Node 22+. Then run `copilot` and enter `/login` to sign in with GitHub.

Official guide: [Installing GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli)

---

After installing, the warning clears on the next capability check — or open the **Capabilities** screen and hit Refresh.
