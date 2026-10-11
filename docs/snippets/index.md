---
type: markdown_index
id: markdown_index-a34feae9-8881-5202-b520-9281688839f2
inputs_hash: c919d045be156fa641ef78e5ef6dce334a9e41dd4dcd07156d40c7fe7851dce8
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-10-07T14:33:53Z'
latest_process_ref: ''
file_count: 27
subfolder_count: 0
---

# snippets

## Self-Summary
> The runnable SDK shelf: one page per capability, every fence pinned by a test. Connections, credentials, data sources, datasets, activity, agents on email, chat and help-desk channels, message threads, LLM endpoints, processes, workflows, compute ops, wizards, decisions, RAG, project dependencies and the one call-return contract.

## Files
- [Snippets — the dev onboarding shelf](README.md) — Index of the runnable SDK snippet shelf for developer onboarding, listing each category, what it shows and the test pinning it.
- [Activity — progress on anything, from anywhere](activity.md) — Snippets for the Activity progress API: path-addressed counters, cheap ticks versus lifecycle transitions, child nodes, and the shared ActivityProgressSpec that consumers read.
- [Agent deployment — snippets](agent-deployment.md) — Runnable snippets on agent deployment: deploying an Agent as a placement on a machine, launching sessions, identity and endpoints
- [Agent email](agent-email.md) — Snippet allocating an Agent mailbox, processing incoming emails through the agent via StreamInbox, and sending threaded replies.
- [Agent help desk](agent-helpdesk.md) — Snippet giving an Agent a hub help desk to answer, creating a helpdesk data source owned by the Agent.
- [An agent on a channel — snippets](agents-on-channels.md) — Snippets for putting an agent on a messaging channel such as WhatsApp, running it in-app or in your own loop, including credential setup.
- [Call → ExitCode → Return](call-returns.md) — Runnable snippets showing how every call, from ops to agent turns, returns one ReturnedValue with an exit code
- [Compute ops — one call that converges, composes, and can ask](compute-ops.md) — ComputeOp snippets: idempotent single-call ops of subkind cli, prompt, agent or ask, with completion checks and typed return values.
- [Connections — Python SDK and CLI](connections.md) — Runnable Python and CLI snippets for OAuth connections: listing the provider catalogue, connecting, testing, and how the local service is borrowed or started.
- [Data sources — snippets](data-sources.md) — Runnable snippets for connecting a DataSource: create from a driver, sync, read rows, subscribe to events, write items, watch a folder.
- [DataSpec](data-spec.md) — Snippets teaching DataSpec schemas and values: declaring frozen, extra-forbidding classes, validation behavior, spec_kind registration, and the function-IO model of passing values.
- [Datasets — snippets](datasets.md) — Runnable snippets on datasets: defining typed row schemas as data_schema folders, using the SmartNavigator eval set as the example
- [Decisions — snippets](decisions.md) — Decision snippets: DecisionSpec closed questions answered with calibrated probabilities through a hub endpoint, with vocabulary mapping to Jev and OpenAI.
- [Gmail source](gmail-source.md) — Snippet: create a Gmail data source from the shipped driver with credentials read from .env.local, never stored.
- [LLM endpoints — snippets](llm-endpoints.md) — Snippets for LLMEndpoint kinds (api_key, hub, device): credential location, completions, embeddings, model listing, probing, and error behavior.
- [Simple message block](message-block.md) — Snippet: send a prompt through a process-local MessageBlock and let an Agent reply, with no worker named.
- [Files, quote-replies and reactions on a channel](message-channels.md) — Snippets for sending files, quote-replies, voice notes and reactions on message channels, with capabilities declared as channel_spec data and unsupported content refused.
- [Threads and replies — one model on every channel](message-threads.md) — Runnable snippets for replying and threading on Flowpad chat and every channel, using reply_to_id and thread_id
- [Pipes — wiring a source to whatever consumes it](pipes.md) — Pipe snippets wiring a data source to consumers: sync cycles, folder mirroring with reflect modes, and following changes as a stream.
- [Processes and agents — snippets](processes.md) — Snippets for Agents and AgenticProcesses: attaching MCP servers across harnesses, running on the mock worker, and typed process input and output.
- [Project dependencies — snippets](project-dependencies.md) — Snippets for declaring project dependencies in flow.json: git, hub and local folder sources, optional dependencies, resolution into session context, autolaunch journey and skills.
- [Project git share](project-git-share.md) — Runnable snippets for sharing a private GitHub repo with project members through the hub, with role-based pull and push access
- [RAG — snippets](rag.md) — RagIndex snippets: covering folders, embedding only unseen chunks, pending versus indexing status, and semantic search over indexed markdown.
- [Secret stores](secret-stores.md) — SecretStore snippets: load, save and validate_keys, and the declare-needs pattern for secrets and connections used by data sources and processes.
- [Service endpoints — snippets](service-endpoints.md) — Snippets explaining Deployment placements and their ServiceEndpoint children, with subkind categories admin, app, agent and service, protocols, and how services are exposed.
- [Wizards — a sequence of calls, and what travels between them](wizards.md) — Runnable snippets on wizards that sequence ComputeOp steps, covering order, on_fail, values passed between steps and the final answer
- [Workflows — snippets](workflows.md) — Workflow snippets for the flow_sdk.blocks plain-Python surface: a mail concierge loop with StreamInbox, agents, resumable position and replies.
