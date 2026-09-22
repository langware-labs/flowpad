---
type: markdown_index
id: markdown_index-a34feae9-8881-5202-b520-9281688839f2
inputs_hash: f36bfbcee29da2c5380cd3923410cf564cb0d475f1bc6142c5fe3ea739b70947
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-09-22T21:12:30.105833+00:00'
latest_process_ref: ''
file_count: 21
subfolder_count: 0
---

# snippets

## Self-Summary
> The runnable SDK shelf: one page per capability, every fence pinned by a test. Connections, credentials, data sources, datasets, activity, agents on email and chat channels, LLM endpoints, processes, workflows, compute ops and the one call-return contract — copyable code rather than prose.

## Files
- [Snippets — the dev onboarding shelf](README.md) — Conventions for the dev snippets shelf: short runnable SDK Python, one file per category, each pinned by a test; values travel as DataSpec.
- [Activity — progress on anything, from anywhere](activity.md) — Activity progress API by example: path-addressed nodes, cheap ticks versus published transitions, and why a finished root is dropped from the live tree.
- [Agent deployment — snippets](agent-deployment.md) — Snippets for placing an agent: Deployment rows, starting a session on a placement, reading and stopping placements, and a dedicated machine.
- [Agent email](agent-email.md) — Snippet: allocate an agent's mailbox and answer each incoming email through the agent with a threaded reply via its StreamInbox.
- [Agent help desk](agent-helpdesk.md) — Giving an Agent a hub help desk: bind_channel adopts the desk as an agent-owned source, and the stream inbox runtime answers every ticket.
- [An agent on a channel — snippets](agents-on-channels.md) — Snippets for putting an agent on a messaging channel like WhatsApp: the credential, the app-runs-it variant, and the your-process-runs-the-loop variant.
- [Call → ExitCode → Return](call-returns.md) — The call-return contract, every fence tested: ComputeOp as one call per subkind, ReturnedValue subclasses, no raised outcomes, role timeouts, ask, wizard and agent continuation.
- [Compute ops — one call that converges, composes, and can ask](compute-ops.md) — Compute op snippets: one convergent call per subkind, asking a person once, a fallback as two ops, retries as the caller's, cancel and silence answers.
- [Connections — Python SDK and CLI](connections.md) — Runnable Python and CLI snippets for OAuth connections: listing the provider catalogue, connecting, testing, and how the local service is borrowed or started.
- [Data sources — snippets](data-sources.md) — Runnable data-source snippets: connect a feed on a driver, sync it once, read the SourceItems, and the per-provider config and secret keys.
- [DataSpec](data-spec.md) — Runnable DataSpec snippets: declaring shapes, shapes written in documents, what a call returns, saving and loading, and file-valued fields.
- [Gmail source](gmail-source.md) — Creating a Gmail data source from the shipped driver, with the app password read from the environment and never stored on the DataSource row.
- [LLM endpoints — snippets](llm-endpoints.md) — Runnable snippets for LLMEndpoint, the answer to who pays for tokens: api_key, hub and device kinds, completions, embeddings, model listing and probes.
- [Simple message block](message-block.md) — Runnable snippet for the process-local MessageBlock: prompt in, reply out, with no address, provider, mailbox or persisted rows.
- [Pipes — wiring a source to whatever consumes it](pipes.md) — Runnable examples wiring a source to its consumer: one sync cycle, folder-to-folder mirroring with reflect, and following changes with ack and redelivery.
- [Processes and agents — snippets](processes.md) — Runnable snippets for processes and agents: attaching MCP servers to a process or an agent, how each harness renders them, and when MCP resolves.
- [RAG — snippets](rag.md) — Runnable snippets for RagIndex: marking folders searchable, chunking and embedding markdown, why re-indexing is cheap, and querying the vectors.
- [Secret stores](secret-stores.md) — SecretStore and Connection: how a consumer declares the names and scopes it needs, gets a provider, and binds it onto the row.
- [Service endpoints — snippets](service-endpoints.md) — ServiceEndpoint snippets: what a placement answers on, reaching endpoints, web-app endpoints, cloud boxes, hub-served endpoints and an agent's chat.
- [Wizards — a sequence of calls, and what travels between them](wizards.md) — Wizard snippets, every fence tested: step order and a step with nothing to do, values passed between steps as environment, a fallback as two steps with one check, a declared output that binds, and a cycle that answers instead of recursing.
- [Workflows — snippets](workflows.md) — Plain-Python workflow snippets with flow_sdk.blocks: a mail concierge, Telegram and Slack bots, and one loop on every channel.
