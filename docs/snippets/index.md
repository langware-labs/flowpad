---
type: markdown_index
id: markdown_index-a34feae9-8881-5202-b520-9281688839f2
inputs_hash: d076400dfa8d214542d44d8de03d232ff7f7640705bf42410a856effdbe5be78
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-11-11T06:55:22.978113+00:00'
latest_process_ref: ''
file_count: 33
subfolder_count: 0
---

# snippets

## Self-Summary
> Runnable SDK recipes for typed data, FlowCall invocation and composition, agent processes and deployments, messaging channels, sources and durable consumers, datasets, credentials, decisions, indexing, and project dependencies. Examples link to their verification tests and distinguish local contracts from live-provider behavior.

## Files
- [Snippets — the dev onboarding shelf](README.md) — Runnable SDK example directory with prerequisite guidance and test mappings, including typed FlowCall blocks, call results, schemas, datasets, and agents.
- [Activity — progress on anything, from anywhere](activity.md) — Snippets for the Activity progress API: path-addressed counters, cheap ticks versus lifecycle transitions, child nodes, and the shared ActivityProgressSpec that consumers read.
- [Agent deployment — snippets](agent-deployment.md) — Agent deployment snippets: Project.deploy, Agent.deploy, Deployment.launch, main agent selection from flow.json, overrides, and endpoint subkinds.
- [Agent email](agent-email.md) — Snippet allocating an Agent mailbox, processing incoming emails through the agent via StreamInbox, and sending threaded replies.
- [Agent help desk](agent-helpdesk.md) — Snippet giving an Agent a hub help desk to answer, creating a helpdesk data source owned by the Agent.
- [An agent on a channel — snippets](agents-on-channels.md) — ---
id: e88a55a6-d845-475e-9dc9-8f98e6b76ac1
---
Snippets for putting an agent on WhatsApp or a phone line, answered by the app or your own loop, with credential setup.
- [Asset dependencies — snippets](asset-dependencies.md) — ---
id: bdff00a2-d751-4c9f-8bea-207a2c5cc999
---
Asset dependency snippets: folder asset's flow.json naming assets by id, transitive resolution across layered data sources, missing-link states, flow dep commands and agent attachments.
- [FlowCall — calls, outcomes, and returned values](call-returns.md) — FlowCall contract: ReturnedValue and ExitCode answers, ComputeOp blocks with declared input and output, ProcessCall, validation and wizard composition.
- [Channel webhooks: from WhatsApp to an agent](channel-webhook-routing.md) — ---
id: 7ffd01cc-2fd3-43c9-95d9-cb7b7e390b0a
---
Guide to routing WhatsApp Cloud API webhooks to an agent: account, user and group hub claims, source-ID delivery, group sources, answer placement and stage-by-stage diagnostics.
- [Compute ops — one call that converges, composes, and can ask](compute-ops.md) — ComputeOp authoring, execution variants, check-before-execute semantics, typed Python blocks, declared outputs, approvals, and executable unit-tested examples.
- [Connections — Python SDK and CLI](connections.md) — Runnable Python and CLI snippets for OAuth connections: listing the provider catalogue, connecting, testing, and how the local service is borrowed or started.
- [Data sources — snippets](data-sources.md) — Data source snippets: creating DataSource assets on drivers, saving data_source.json, running source.sync(), and reading SourceItems, all pinned by unit tests.
- [DataSpec](data-spec.md) — Typed DataSpec authoring, namespaces, records, lists, references, shape validation, folder serialization, and executable schema examples.
- [Datasets — snippets](datasets.md) — Dataset snippets: data_schema folder row schemas, typed input/context/ground_truth/output slots, using the SmartNavigator eval set stored outside the repo.
- [Decisions — snippets](decisions.md) — Decisions snippets: DecisionSpec state with up to six named questions, DecisionResult probabilities, hub APIEndpoint kind decision, and vocabulary mapping to Jev and OpenAI.
- [FlowCall blocks — typed input, call.py, output](flowcall-blocks.md) — Typed ComputeOp authoring with call.py, whole-list inputs, Wizard-backed chains, explicit maps, references, approval, invocation tracing, and bounded call logs.
- [Gmail source](gmail-source.md) — Gmail source snippet: set GMAIL_ADDRESS and GMAIL_APP_PASSWORD, create and save a gmail DataDriver source, password never stored in the row.
- [LLM endpoints — snippets](llm-endpoints.md) — LLM endpoint snippets: api_key, hub and device LLMEndpointKind credentials, create_completion, embeddings, list_models, probe calls and typed errors.
- [Simple message block](message-block.md) — Snippet: send a prompt through a process-local MessageBlock and let an Agent reply, with no worker named.
- [Files, quote-replies and reactions on a channel](message-channels.md) — Snippets for sending files, quote-replies, voice notes and reactions on message channels, with capabilities declared as channel_spec data and unsupported content refused.
- [Threads and replies — one model on every channel](message-threads.md) — Message threads model: reply_to_id and thread_id across Flowpad chat and channel conversations, with send reply_to and in_thread snippets and channel_spec capabilities.
- [Pipes — wiring a source to whatever consumes it](pipes.md) — Pipe snippets wiring a data source to consumers: sync cycles, folder mirroring with reflect modes, and following changes as a stream.
- [Processes and agents — snippets](processes.md) — AgenticProcess creation and execution examples, admission versus completion, structured FlowCall results, typed block alternatives, and process lifecycle APIs.
- [Project dependencies — snippets](project-dependencies.md) — Project dependency declarations, resolution, shared context, cross-project documents and agents, sharing, and equivalent CLI operations.
- [Project git share](project-git-share.md) — Runnable snippets for sharing a private GitHub repo with project members through the hub, with role-based pull and push access
- [RAG — snippets](rag.md) — RagIndex snippets: covering folders, embedding only unseen chunks, pending versus indexing status, and semantic search over indexed markdown.
- [Relationship pickers in SDK viewers](relationship-pickers.md) — Relationship pickers in SDK viewers: ViewerHost.candidates provider contract returning {key,label,value} items, mountRelationshipPicker, and paging and search rules.
- [Scan and index — snippets](scan-and-index.md) — Scan-and-index snippets for flow_sdk.diskio interfaces: tree walking with gitignore/flowignore, typed asset discovery, document reading, link extraction, Python/Rust backend switch.
- [Secret stores](secret-stores.md) — SecretStore pattern: typed stores with load, save and validate_keys, the three-step access pattern for secrets and connections, with tested snippets.
- [Service endpoints — snippets](service-endpoints.md) — Service endpoint snippets: Deployment on a ComputeNode with ServiceEndpoint children per exposed service, subkind and protocol, routed app mounts and proxies.
- [Stream stream inbox automations — snippets](stream-inbox-automations.md) — Stream inbox automation snippets: TAG Triggers on stream_inbox message events with a decision-op if gate and a wizard then step, compiled by the backend.
- [Wizards — a sequence of calls, and what travels between them](wizards.md) — Wizards sequencing ComputeOp calls: steps with when, on_result, on_fail, input_from, input_value, output_from, chain and map_calls, with tested snippets.
- [Workflows — snippets](workflows.md) — Workflow snippets for flow_sdk.blocks: plain-Python async blocks passing DataSpec values, the mail concierge program, and MessageBlock reply correlation.
