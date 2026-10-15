---
type: markdown_index
id: markdown_index-a34feae9-8881-5202-b520-9281688839f2
inputs_hash: 2ef3073f4f3a3e4a6de7cea01714adf80e08518a908397d9d76e9c7601ddbc7e
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/alice/Documents/dev/flowpad-oss/docs
generated_at: '2026-10-15T09:19:50.046891+00:00'
latest_process_ref: ''
file_count: 32
subfolder_count: 0
---

# snippets

## Self-Summary
> Runnable SDK examples with validating tests: FlowCall outcomes and returned values, ComputeOps, wizards, schemas, agents, channels, data sources, datasets, credentials, dependencies, deployment, activity, scanning, and RAG.

## Files
- [Snippets — the dev onboarding shelf](README.md) — Runnable SDK example directory with prerequisite guidance and test mappings, including typed FlowCall blocks, call results, schemas, datasets, and agents.
- [Activity — progress on anything, from anywhere](activity.md) — Snippets for the Activity progress API: path-addressed counters, cheap ticks versus lifecycle transitions, child nodes, and the shared ActivityProgressSpec that consumers read.
- [Agent deployment — snippets](agent-deployment.md) — ---
id: a67d0e93-70ef-4e56-8449-75b918f858af
---
Runnable snippets on agent deployment: placing an Agent on a machine, launching sessions, pausing, cloud deploy, custom channel routing, and the per-deployment local agent loop.
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
- [FlowCall — calls, outcomes, and returned values](call-returns.md) — FlowCall contract and interfaces: ReturnedValue outcomes, typed value presence, ComputeOp execution, Wizard composition, agent completion, and wire serialization.
- [Channel webhooks: from WhatsApp to an agent](channel-webhook-routing.md) — ---
id: 7ffd01cc-2fd3-43c9-95d9-cb7b7e390b0a
---
Guide to routing WhatsApp Cloud API webhooks to an agent: account, user and group hub claims, source-ID delivery, group sources, answer placement and stage-by-stage diagnostics.
- [Compute ops — one call that converges, composes, and can ask](compute-ops.md) — ComputeOp authoring, execution variants, check-before-execute semantics, typed Python blocks, declared outputs, approvals, and executable unit-tested examples.
- [Connections — Python SDK and CLI](connections.md) — Runnable Python and CLI snippets for OAuth connections: listing the provider catalogue, connecting, testing, and how the local service is borrowed or started.
- [Data sources — snippets](data-sources.md) — ---
id: 34ca3b65-68ed-41ec-b3f8-5eee9959d4e8
---
Runnable DataSource snippets: connect and sync a feed, reuse by account, search, mirror folders, subscribe to events, write items, reply, merge sources, write a driver.
- [DataSpec](data-spec.md) — Typed DataSpec authoring, namespaces, records, lists, references, shape validation, folder serialization, and executable schema examples.
- [Datasets — snippets](datasets.md) — Runnable dataset snippets: data_schema row kinds, rows by key, links, evals, SmartNavigationLog, mirroring via sync, query, count and text search, and editing outside-owned fields.
- [Decisions — snippets](decisions.md) — ---
id: 3cfa1e2e-fc53-444c-b785-c41a0623b92e
---
Decision snippets: DecisionSpec closed questions answered with calibrated probabilities through a hub endpoint, the Jev and OpenAI vocabulary, navigator routing, and decision wizard steps.
- [FlowCall blocks — typed input, call.py, output](flowcall-blocks.md) — Typed FlowCall blocks across seven variants, with input/output routing, runnable Python list processing, Wizard chains, mapping, nullable values, references and scoped calls.
- [Gmail source](gmail-source.md) — Snippet: create a Gmail data source from the shipped driver with credentials read from .env.local, never stored.
- [LLM endpoints — snippets](llm-endpoints.md) — ---
id: a49769db-3e4c-4a8b-95f7-c53c082602ff
---
Snippets for LLMEndpoint kinds (api_key, hub, device): credential location, completions, embeddings, model listing, probing, harness resolution, public loginless endpoints, and error behavior.
- [Simple message block](message-block.md) — Snippet: send a prompt through a process-local MessageBlock and let an Agent reply, with no worker named.
- [Files, quote-replies and reactions on a channel](message-channels.md) — Snippets for sending files, quote-replies, voice notes and reactions on message channels, with capabilities declared as channel_spec data and unsupported content refused.
- [Threads and replies — one model on every channel](message-threads.md) — Runnable snippets for replying and threading on Flowpad chat and every channel, using reply_to_id and thread_id
- [Pipes — wiring a source to whatever consumes it](pipes.md) — Pipe snippets wiring a data source to consumers: sync cycles, folder mirroring with reflect modes, and following changes as a stream.
- [Processes and agents — snippets](processes.md) — AgenticProcess creation and execution examples, admission versus completion, structured FlowCall results, typed block alternatives, and process lifecycle APIs.
- [Project dependencies — snippets](project-dependencies.md) — Project dependency declarations, resolution, shared context, cross-project documents and agents, sharing, and equivalent CLI operations.
- [Project git share](project-git-share.md) — Runnable snippets for sharing a private GitHub repo with project members through the hub, with role-based pull and push access
- [RAG — snippets](rag.md) — RagIndex snippets: covering folders, embedding only unseen chunks, pending versus indexing status, and semantic search over indexed markdown.
- [Scan and index — snippets](scan-and-index.md) — Runnable diskio examples for tree walking, asset scanning, document reading, link extraction, and Python or Rust backend selection.
- [Secret stores](secret-stores.md) — Secret-store examples for credentials, environment variables, source access, account connections, deployment binding, validation, and project setup.
- [Service endpoints — snippets](service-endpoints.md) — ServiceEndpoint examples covering deployment services, routing, web apps, cloud addressing, agent chat, and health checks.
- [Stream stream inbox automations — snippets](stream-inbox-automations.md) — Stream inbox automation examples combining Trigger policies, decision gates, wizard execution, FlowCall answers, agent inputs, and TypeScript operations.
- [Wizards — a sequence of calls, and what travels between them](wizards.md) — Declarative Wizard composition, checks, inputs, typed input_from bindings, selected output values, step results, approvals, and unit-tested execution examples.
- [Workflows — snippets](workflows.md) — Plain-Python workflow examples composing channel messages, agents, FlowCall results, streams, and transient message blocks.
