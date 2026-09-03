# Snippets — the dev onboarding shelf

Short, runnable Python against the SDK. One file per category, every snippet
pinned by a test so it cannot drift silently.

| Category | What it shows | Pinned by |
| --- | --- | --- |
| [Simple message source](message-source.md) | send a prompt through a process-local channel and let an Agent reply | `tests/unit/test_message_source.py`, `tests/unit/test_message_source_snippet.py` |
| [Data sources](data-sources.md) | connect a source, sync it, read the rows, subscribe to events, write items in, watch a folder | `tests/unit/test_ingest_end_to_end.py`, `tests/unit/test_folder_source/`, `tests/unit/test_ingest_write_route.py` |
| [Gmail message source](gmail-message-source.md) | create an app-password Gmail source without persisting its password | `tests/unit/test_gmail_driver.py` |
| [Agent email](agent-email.md) | allocate an Agent inbox, listen for mail, run the Agent and send a threaded reply | `tests/hub_tests/test_agent_email_conversation.py`, `tests/long_tests/test_blocks_email_workflow.py` |
| [Workflows](workflows.md) | the plain-Python `blocks` surface: an inbox, an agent runner, a typed reply, on email, Telegram and Slack | `tests/long_tests/test_blocks_email_workflow.py`, `tests/unit/test_blocks_email.py`, `tests/unit/test_slack_driver.py` |
| [Connections](connections.md) | list, connect and verify providers from a Python REPL or `flow connections` | `tests/unit/test_connections.py`, `tests/unit/test_connections_cli.py` |
| [Processes and agents](processes.md) | give a process or an agent an MCP server, launch it, read the answer | `tests/long_tests/test_process_mcp_multi_vendor.py` |
| [LLM endpoints](llm-endpoints.md) | fund a call: a provider key, a hub budget or a device login; complete, embed, list, probe | `tests/unit/test_llm_endpoint_rows.py`, `tests/unit/test_llm_client.py`, `tests/long_tests/test_llm_endpoint_live.py` |
| [RAG](rag.md) | make a folder searchable, run a pass, ask it something, chunk and store on their own | `tests/unit/test_rag_snippets.py` (runs every snippet), `tests/unit/test_rag_indexing.py` |

## Conventions

* **No snippet requires manual service setup.** Most run directly in-process;
  connection operations lease the selected standard service for their normal
  HTTP actions and restore its initial up/down state. Long tests that pin live
  legs run under the standard 30s cap and skip without credentials.
* **Import the drivers once.** `import flow_sdk.ingest.drivers` registers the
  eleven shipped providers (`rss`, `hackernews`, `folder`, `git`, `gdrive`,
  `gmail`, `agentmail`, `cloud_email`, `slack`, `telegram`, `agent`). Without it
  `get_driver()` returns `None` and a source parks on `config_error`.
* **Values travel as `DataSpec`.** What a driver emits is a
  `SourceItemSpec`, what you send back is a `MessageSpec` subclass, and what an
  agent returns is a `RunOutput`. They are frozen and refuse unknown keys. A
  simple `MessageSource` yields an ephemeral `MessageRequest`; the source owns
  its one-shot reply correlation.
* **Read before you believe.** A verb returning does not mean rows landed.
  Count with `SourceItem.get_all({"data_source_id": ...})`.

Adding a category: create `docs/snippets/<category>.md`, name the test that
pins each snippet, add a row above.
