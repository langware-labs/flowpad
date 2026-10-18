---
type: markdown_index
id: markdown_index-a34feae9-8881-5202-b520-9281688839f2
inputs_hash: 40befe51e1c1d30083e80a517df6a809554d80e06e8210563a1021c6a56e8591
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-10-15T17:55:38.057586+00:00'
latest_process_ref: ''
file_count: 33
subfolder_count: 0
---

# snippets

## Self-Summary
> Runnable SDK recipes for typed data, FlowCall invocation and composition, agent processes and deployments, messaging channels, sources and durable consumers, datasets, credentials, decisions, indexing, and project dependencies. Examples link to their verification tests and distinguish local contracts from live-provider behavior.

## Files
- [Snippets — the dev onboarding shelf](README.md) — Runnable SDK onboarding recipes index: category links, pinning tests, channel routing, typed values, and conventions for sources, agents, workflows, and FlowCall.
- [Activity — progress on anything, from anywhere](activity.md) — Snippets for the Activity progress API: path-addressed counters, cheap ticks versus lifecycle transitions, child nodes, and the shared ActivityProgressSpec that consumers read.
- [Agent deployment — snippets](agent-deployment.md) — Runnable snippets on agent deployment: placing an Agent on a machine, launching sessions, pausing, cloud deploy, custom channel routing, and the per-deployment local agent loop.
- [Agent email](agent-email.md) — Snippet allocating an Agent mailbox, processing incoming emails through the agent via StreamInbox, and sending threaded replies.
- [Agent help desk](agent-helpdesk.md) — Snippet giving an Agent a hub help desk to answer, creating a helpdesk data source owned by the Agent.
- [An agent on a channel — snippets](agents-on-channels.md) — Snippets for putting an agent on WhatsApp or a phone line, answered by the app or your own loop, with credential setup.
- [Asset dependencies — snippets](asset-dependencies.md) — Asset dependency snippets: folder asset's flow.json naming assets by id, transitive resolution across layered data sources, missing-link states, flow dep commands and agent attachments.
- [FlowCall — calls, outcomes, and returned values](call-returns.md) — FlowCall outcomes and typed ReturnedValue contracts, durable invocation, admission versus completion, serialization, value presence, executor correlation, and Wizard composition.
- [Channel webhooks: from WhatsApp to an agent](channel-webhook-routing.md) — Guide to routing WhatsApp Cloud API webhooks to an agent: account, user and group hub claims, source-ID delivery, group sources, answer placement and stage-by-stage diagnostics.
- [Compute ops — one call that converges, composes, and can ask](compute-ops.md) — ComputeOp authoring, execution variants, check-before-execute semantics, typed Python blocks, declared outputs, approvals, and executable unit-tested examples.
- [Connections — Python SDK and CLI](connections.md) — Runnable Python and CLI snippets for OAuth connections: listing the provider catalogue, connecting, testing, and how the local service is borrowed or started.
- [Data sources — snippets](data-sources.md) — Runnable DataSource snippets: connect and sync a feed, reuse by account, search, mirror folders, subscribe to events, write items, reply, merge sources, write a driver.
- [DataSpec](data-spec.md) — Typed DataSpec authoring, namespaces, records, lists, references, shape validation, folder serialization, and executable schema examples.
- [Datasets — snippets](datasets.md) — Dataset snippets: row schemas as folders, reading and writing rows, evaluation, rows by key, links, mirroring, relational queries, aggregation, and source-owned field writes.
- [Decisions — snippets](decisions.md) — Decision snippets: DecisionSpec closed questions answered with calibrated probabilities through a hub endpoint, the Jev and OpenAI vocabulary, navigator routing, and decision wizard steps.
- [FlowCall blocks — typed input, call.py, output](flowcall-blocks.md) — Typed ComputeOp authoring with call.py, whole-list inputs, Wizard-backed chains, explicit maps, references, approval, invocation tracing, and bounded call logs.
- [Gmail source](gmail-source.md) — Gmail source creation from the shipped driver with an app password kept out of the row, and the OAuth gmail_send helper for report senders.
- [LLM endpoints — snippets](llm-endpoints.md) — Snippets for LLMEndpoint kinds (api_key, hub, device): credential location, completions, embeddings, model listing, probing, harness resolution, public loginless endpoints, and error behavior.
- [Simple message block](message-block.md) — Snippet: send a prompt through a process-local MessageBlock and let an Agent reply, with no worker named.
- [Files, quote-replies and reactions on a channel](message-channels.md) — Snippets for sending files, quote-replies, voice notes and reactions on message channels, with capabilities declared as channel_spec data and unsupported content refused.
- [Threads and replies — one model on every channel](message-threads.md) — Runnable snippets for replying and threading on Flowpad chat and every channel, using reply_to_id and thread_id
- [Pipes — wiring a source to whatever consumes it](pipes.md) — Pipe snippets wiring a data source to consumers: sync cycles, folder mirroring with reflect modes, and following changes as a stream.
- [Processes and agents — snippets](processes.md) — AgenticProcess creation and execution examples, admission versus completion, structured FlowCall results, typed block alternatives, and process lifecycle APIs.
- [Project dependencies — snippets](project-dependencies.md) — Project dependency declarations, resolution, shared context, cross-project documents and agents, sharing, and equivalent CLI operations.
- [Project git share](project-git-share.md) — Runnable snippets for sharing a private GitHub repo with project members through the hub, with role-based pull and push access
- [RAG — snippets](rag.md) — RagIndex snippets: covering folders, embedding only unseen chunks, pending versus indexing status, and semantic search over indexed markdown.
- [Relationship pickers in SDK viewers](relationship-pickers.md) — SDK relationship candidate providers, dependent queries, search and pagination, ordered selections, readonly controls, and Dataset-owned validation and version conflicts.
- [Scan and index — snippets](scan-and-index.md) — Runnable diskio examples for tree walking, asset scanning, document reading, link extraction, and Python or Rust backend selection.
- [Secret stores](secret-stores.md) — Secret-store examples for credentials, environment variables, source access, account connections, deployment binding, validation, and project setup.
- [Service endpoints — snippets](service-endpoints.md) — Deployment service endpoints, audience routes, protocol proxies, port ownership, cloud access grants, agent chat channels, and endpoint health checks.
- [Stream stream inbox automations — snippets](stream-inbox-automations.md) — Stream inbox automation examples combining Trigger policies, decision gates, wizard execution, FlowCall answers, agent inputs, and TypeScript operations.
- [Wizards — a sequence of calls, and what travels between them](wizards.md) — Declarative Wizard composition, checks, inputs, typed input_from bindings, selected output values, step results, approvals, and unit-tested execution examples.
- [Workflows — snippets](workflows.md) — Plain-Python workflow examples composing channel messages, agents, FlowCall results, streams, and transient message blocks.
