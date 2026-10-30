---
id: 3abf19d7-f3e0-5326-b22f-ef52f67d57ae
title: Testing credentials
---

# Testing credentials

**"Connected" means a value is there. "Tested" means the provider takes it.** A key can be present and still dead — revoked, expired or mistyped — and only a call to the provider tells.

- **Test** on a credential's row (and on its page) runs the credential's own test: a quick, read-only request to the provider with your values. Green means the key works; red shows the provider's reason, with the key itself hidden.
- **No test yet?** The first Test starts an agent beside the credential. It finds the provider's cheapest check, tries it once with your values, and writes it into the credential. You see what it does and can answer its questions in the same panel. Every Test after that is instant and runs no agent.
- **Project setup** runs the test too, so a rejected key is asked for again instead of counting as done.
- The test travels with the credential (it is part of `credential.json`). The result is your computer's only.

From the command line: `flow credentials test <name>` runs it (exit 0 when the key works); `flow credentials check <name>` checks the values are there and, when the credential has a test, that they work.
