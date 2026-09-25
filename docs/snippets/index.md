---
type: markdown_index
id: markdown_index-a34feae9-8881-5202-b520-9281688839f2
inputs_hash: f7d6b2f836466f67180f84bc54bfbc386f869578d79932e446e674cd887f40c8
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-09-25T12:04:30Z'
latest_process_ref: ''
file_count: 21
subfolder_count: 0
---

# snippets

## Self-Summary
> The runnable SDK shelf: one page per capability, every fence pinned by a test. Connections, credentials, data sources, datasets, activity, agents on email and chat channels, LLM endpoints, processes, workflows, compute ops and the one call-return contract — copyable code rather than prose.

## Files
- [Snippets — the dev onboarding shelf](README.md) — Index of the tested developer snippet pages: each category, what it shows, and the test that pins every fence.
- [Activity — progress on anything, from anywhere](activity.md) — Activity progress API by example: path-addressed nodes, cheap ticks versus published transitions, and why a finished root is dropped from the live tree.
- [Agent deployment — snippets](agent-deployment.md) — Snippets for placing an agent, starting sessions, reading placements, pausing, serving it your own way, and running it locally.
- [Agent email](agent-email.md) — Snippet: allocate an agent mailbox, listen for mail with StreamInbox, run the agent and send threaded replies.
- [Agent help desk](agent-helpdesk.md) — Snippet: bind a hub help desk to an agent so it answers the desk's conversations as the agent.
- [An agent on a channel — snippets](agents-on-channels.md) — Put an agent on WhatsApp: declare the credential, let the app answer, or run the answering loop yourself.
- [Call → ExitCode → Return](call-returns.md) — The one-answer contract: ComputeOp calls, ReturnedValue and its subclasses including PromptResult files, exit codes, timeouts and wizards.
- [Compute ops — one call that converges, composes, and can ask](compute-ops.md) — Compute op snippets: one convergent call per subkind, asking a person once even outside the backend, a fallback as two ops, caller-owned retries, cancel and silence answers.
- [Connections — Python SDK and CLI](connections.md) — Runnable Python and CLI snippets for OAuth connections: listing the provider catalogue, connecting, testing, and how the local service is borrowed or started.
- [Data sources — snippets](data-sources.md) — Runnable data-source snippets: connect a feed on a driver, sync it once, read the SourceItems, and the per-provider config and secret keys.
- [DataSpec](data-spec.md) — Runnable DataSpec snippets: declaring shapes, shapes written in documents, what a call returns, saving and loading, and file-valued fields.
- [Gmail source](gmail-source.md) — Snippet: create a Gmail data source from the shipped driver with credentials read from .env.local, never stored.
- [LLM endpoints — snippets](llm-endpoints.md) — Runnable snippets for LLMEndpoint, the answer to who pays for tokens: api_key, hub and device kinds, completions, embeddings, model listing and probes.
- [Simple message block](message-block.md) — Snippet: send a prompt through a process-local MessageBlock and let an Agent reply, with no worker named.
- [Pipes — wiring a source to whatever consumes it](pipes.md) — Runnable examples wiring a source to its consumer: one sync cycle, folder-to-folder mirroring with reflect, and following changes with ack and redelivery.
- [Processes and agents — snippets](processes.md) — Process and agent snippets: MCP servers, launching and reading answers, and typed folder in/out with run(input, output_spec).
- [RAG — snippets](rag.md) — Runnable snippets for RagIndex: marking folders searchable, chunking and embedding markdown, why re-indexing is cheap, and querying the vectors.
- [Secret stores](secret-stores.md) — Secret stores: load, save and validate named secrets, credentials per environment, binding stores and connections, flow project setup.
- [Service endpoints — snippets](service-endpoints.md) — ServiceEndpoint snippets: what a placement answers on, the service proxy, web app endpoints, cloud boxes and an agent's chat.
- [Wizards — a sequence of calls, and what travels between them](wizards.md) — Wizard snippets, every fence tested: step order and a step with nothing to do, values passed between steps as environment, a fallback as two steps with one check, a declared output that binds, and a cycle that answers instead of recursing.
- [Workflows — snippets](workflows.md) — Plain-Python workflow snippets with flow_sdk.blocks: a mail concierge, Telegram and Slack bots, and one loop on every channel.
