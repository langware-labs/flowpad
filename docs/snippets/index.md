---
type: markdown_index
id: markdown_index-a34feae9-8881-5202-b520-9281688839f2
inputs_hash: 28def270ed5aeca9543c388d5f65884c6381d788a38f51bac6bfc7b7c7095d50
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/alice/Documents/dev/flowpad-oss/docs
generated_at: '2026-10-13T12:09:58Z'
latest_process_ref: ''
file_count: 30
subfolder_count: 0
---

# snippets

## Self-Summary
> The runnable SDK shelf: one page per capability, every fence pinned by a test. Connections, credentials, data sources, datasets, activity, agents on email, chat and help-desk channels, channel webhook routing, message threads, stream inbox automations, LLM endpoints, processes, workflows, compute ops, wizards, decisions, RAG, project and asset dependencies and the one call-return contract.

## Files
- [Snippets — the dev onboarding shelf](README.md) — Index of the runnable SDK snippet shelf for developer onboarding, listing each category, what it shows, the test pinning it, and shelf conventions.
- [Activity — progress on anything, from anywhere](activity.md) — Snippets for the Activity progress API: path-addressed counters, cheap ticks versus lifecycle transitions, child nodes, and the shared ActivityProgressSpec that consumers read.
- [Agent deployment — snippets](agent-deployment.md) — Runnable snippets on agent deployment: placing an Agent on a machine, launching sessions, pausing, cloud deploy, custom channel routing, and the per-deployment local agent loop.
- [Agent email](agent-email.md) — Snippet allocating an Agent mailbox, processing incoming emails through the agent via StreamInbox, and sending threaded replies.
- [Agent help desk](agent-helpdesk.md) — Snippet giving an Agent a hub help desk to answer, creating a helpdesk data source owned by the Agent.
- [An agent on a channel — snippets](agents-on-channels.md) — Snippets for putting an agent on WhatsApp or a phone line, answered by the app or your own loop, with credential setup.
- [Asset dependencies — snippets](asset-dependencies.md) — Asset dependency snippets: folder asset's flow.json naming assets by id, transitive resolution across layered data sources, missing-link states, flow dep commands and agent attachments.
- [Call → ExitCode → Return](call-returns.md) — Runnable snippets showing how every call, from ComputeOps and wizards to agent turns, returns one ReturnedValue subclass with an exit code, plus timeout rules.
- [Channel webhooks: from WhatsApp to an agent](channel-webhook-routing.md) — Guide to routing WhatsApp Cloud API webhooks to an agent: account, user and group hub claims, source-ID delivery, group sources, answer placement and stage-by-stage diagnostics.
- [Compute ops — one call that converges, composes, and can ask](compute-ops.md) — ComputeOp snippets: idempotent single-call ops of subkind cli, decision, prompt, agent or ask, with completion checks, attempts ladders and typed return values.
- [Connections — Python SDK and CLI](connections.md) — Runnable Python and CLI snippets for OAuth connections: listing the provider catalogue, connecting, testing, and how the local service is borrowed or started.
- [Data sources — snippets](data-sources.md) — Runnable DataSource snippets: connect and sync a feed, reuse by account, search, mirror folders, subscribe to events, write items, reply, merge sources, write a driver.
- [DataSpec](data-spec.md) — Tested snippets teaching DataSpec schemas and values: declaring classes, authoring forms and parse, spec_kind registration, ReturnedValue, save/load folders, Text and Binary file fields, identity carriers.
- [Datasets — snippets](datasets.md) — Runnable dataset snippets: data_schema row kinds, reading and writing rows by key, links, evals, SmartNavigationLog, mirroring via sync, and query, count and text search.
- [Decisions — snippets](decisions.md) — Decision snippets: DecisionSpec closed questions answered with calibrated probabilities through a hub endpoint, the Jev and OpenAI vocabulary, navigator routing, and decision wizard steps.
- [Gmail source](gmail-source.md) — Snippet: create a Gmail data source from the shipped driver with credentials read from .env.local, never stored.
- [LLM endpoints — snippets](llm-endpoints.md) — Snippets for LLMEndpoint kinds (api_key, hub, device): credential location, completions, embeddings, model listing, probing, harness resolution, public loginless endpoints, and error behavior.
- [Simple message block](message-block.md) — Snippet: send a prompt through a process-local MessageBlock and let an Agent reply, with no worker named.
- [Files, quote-replies and reactions on a channel](message-channels.md) — Snippets for sending files, quote-replies, voice notes and reactions on message channels, with capabilities declared as channel_spec data and unsupported content refused.
- [Threads and replies — one model on every channel](message-threads.md) — Runnable snippets for replying and threading on Flowpad chat and every channel, using reply_to_id and thread_id
- [Pipes — wiring a source to whatever consumes it](pipes.md) — Pipe snippets wiring a data source to consumers: sync cycles, folder mirroring with reflect modes, and following changes as a stream.
- [Processes and agents — snippets](processes.md) — Snippets for Agents and AgenticProcesses: attaching MCP servers across harnesses, running on the mock worker, and typed process input and output.
- [Project dependencies — snippets](project-dependencies.md) — Snippets for declaring project dependencies in flow.json: git, hub and local folder sources, resolution states, provider load lifecycle, cross-project processes and agents, and CLI verbs.
- [Project git share](project-git-share.md) — Runnable snippets for sharing a private GitHub repo with project members through the hub, with role-based pull and push access
- [RAG — snippets](rag.md) — RagIndex snippets: covering folders, embedding only unseen chunks, pending versus indexing status, and semantic search over indexed markdown.
- [Secret stores](secret-stores.md) — SecretStore snippets: load, save and validate_keys across env_file, vault and GCP stores, credential and data source bindings, connections with scopes, and flow project setup.
- [Service endpoints — snippets](service-endpoints.md) — Snippets on Deployment placements and their ServiceEndpoint children: subkinds, audience proxies with web app routes, cloud box grants, an agent's chat channel, and health checks.
- [Stream stream inbox automations — snippets](stream-inbox-automations.md) — Stream inbox automation snippets: a TAG Trigger on projected messages whose if is a decision-op gate and whose then runs a wizard or agent.
- [Wizards — a sequence of calls, and what travels between them](wizards.md) — Runnable snippets on wizards that sequence ComputeOp steps: order, on_fail, values bound between steps, when conditions, declared output, upfront ask planning, exit_error and shared shell.
- [Workflows — snippets](workflows.md) — Workflow snippets for the flow_sdk.blocks plain-Python surface: a mail concierge loop with StreamInbox, agents, resumable position and replies.
