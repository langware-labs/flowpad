---
id: 0f1a0581-19a5-5364-b0f3-3703bfe0e5c8
name: flowpad-test-skill
description: TEST-ONLY skill used by the vitest suite to verify the Flowpad Assistant project is mounted (--add-dir) and its skills are discoverable to the agentic-process worker. Not a product feature. When invoked, output exactly the marker FLOWPAD_TEST_SKILL_OK.
allowed-tools:
- Read
---

# Flowpad Test Skill

This skill exists only to validate, from a vitest, that the Flowpad Assistant
system project was mounted into the worker via `--add-dir` and that its
`.claude/skills` are therefore discoverable.

When asked to use this skill, respond with exactly:

```
FLOWPAD_TEST_SKILL_OK
```
