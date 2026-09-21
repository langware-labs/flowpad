---
type: markdown_index
id: markdown_index-a34feae9-8881-5202-b520-9281688839f2
inputs_hash: 79482712bcafa8d195eed38416bf876302bc1af090e1c7bf5cdcf89dc0862ce9
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-09-19T23:43:15.734237+00:00'
latest_process_ref: ''
file_count: 17
subfolder_count: 0
---

# snippets

## Self-Summary
> The runnable SDK shelf: one page per capability, every fence pinned by a test. Connections, credentials, data sources, datasets, activity, agents on email and chat channels, LLM endpoints, processes and workflows — copyable code rather than prose.

## Files
- [Snippets — the dev onboarding shelf](README.md) — Index of the runnable SDK snippet shelf, one page per category, naming the test that pins each so the examples cannot drift.
- [Activity — progress on anything, from anywhere](activity.md) — Activity progress API by example: path-addressed nodes, cheap ticks versus published transitions, and why a finished root is dropped from the live tree.
- [Agent deployment — snippets](agent-deployment.md) — Runnable snippets for placing an Agent as a Deployment and launching it into an AgenticProcess, with the local placement and dispatch contracts.
- [Service endpoints — snippets](service-endpoints.md) — What a Deployment exposes: ServiceEndpoint protocols and backends, the pure `service` proxy, `direct-url`, webapp endpoints and cloud exposure.
- [Agent email](agent-email.md) — Runnable snippet giving an Agent its own mailbox and answering incoming mail in a threaded reply through StreamInbox.listen.
- [Agent help desk](agent-helpdesk.md) — Giving an Agent a hub help desk: bind_channel adopts the desk as an agent-owned source, and the stream inbox runtime answers every ticket.
- [An agent on a channel — snippets](agents-on-channels.md) — Putting an agent on a messaging channel, WhatsApp as the example: the credential, the app-answers variant, and running your own loop over the same SDK.
- [Connections — Python SDK and CLI](connections.md) — Runnable Python and CLI snippets for OAuth connections: listing the provider catalogue, connecting, testing, and how the local service is borrowed or started.
- [Data sources — snippets](data-sources.md) — Runnable data-source snippets: connect a feed on a driver, sync it once, read the SourceItems, and the per-provider config and secret keys.
- [DataSpec](data-spec.md) — Runnable DataSpec examples: declaring a shape, frozen and extra-forbid semantics, parsing an authoring form from a document, and the three authoring forms.
- [Gmail source](gmail-source.md) — Creating a Gmail data source from the shipped driver, with the app password read from the environment and never stored on the DataSource row.
- [LLM endpoints — snippets](llm-endpoints.md) — Runnable snippets for LLMEndpoint, the answer to who pays for tokens: api_key, hub and device kinds, completions, embeddings, model listing and probes.
- [Simple message block](message-block.md) — Runnable snippet for the process-local MessageBlock: prompt in, reply out, with no address, provider, mailbox or persisted rows.
- [Pipes — wiring a source to whatever consumes it](pipes.md) — Runnable examples wiring a source to its consumer: one sync cycle, folder-to-folder mirroring with reflect, and following changes with ack and redelivery.
- [Processes and agents — snippets](processes.md) — Runnable snippets for processes and agents: attaching MCP servers to a process or an agent, how each harness renders them, and when MCP resolves.
- [RAG — snippets](rag.md) — Runnable snippets for RagIndex: marking folders searchable, chunking and embedding markdown, why re-indexing is cheap, and querying the vectors.
- [Secret stores](secret-stores.md) — SecretStore and Connection: how a consumer declares the names and scopes it needs, gets a provider, and binds it onto the row.
- [Workflows — snippets](workflows.md) — Runnable flow_sdk.blocks workflow examples: the mail concierge loop over a StreamInbox, named consumer positions, agent turns and typed replies that ack.
