Runs `flow llm set auto`. With a source already resolved it returns at once; with none it sends the open app to the LLM chooser (connect Claude Code, Codex, GitHub Copilot, or sign in to Flowpad) and waits for a choice.

The check is the same command with `--no-browser`: it exits 0 when the box is funded and 4 without opening anything when it is not.

First-run setup runs this BEFORE the llm-setup wizard (`run_llm_setup` in `server/builtin_triggers.py`), not as one of its steps. A run that ends with no source — the person pressed Skip — is not the end of setup: the wizard still runs, and only its agent fallbacks need the source.
