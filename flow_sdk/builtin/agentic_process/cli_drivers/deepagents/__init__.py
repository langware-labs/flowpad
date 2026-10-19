"""Deep Agents worker — LangChain's ``deepagents`` harness behind a FlowPad runner CLI.

A provider mirror for the ENGINE; the runner (``runner.py``) and its JSONL event protocol are
ours. Headless-only and hidden from every picker: it exists so a box with nothing but an LLM
endpoint still has a worker (the builtin bootstrap process). Nothing heavy is imported here —
the LangChain stack loads only inside the runner subprocess.
"""
