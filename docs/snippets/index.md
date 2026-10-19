---
type: markdown_index
id: markdown_index-c6cc7e2f-a8f7-5be3-a69e-2c70a334bd60
inputs_hash: d2fde28a31588434ccf4aaebd821fb651cd80b7071aae2c8fa3a621dc7965674
template_version: 1
prompt_version: 1
parent_ref: markdown_index-0909616b-4692-5d1d-a02e-a155e2fe2bbb
vault_root: /Users/tzahi/_dev/langware/github/flowpad-open-source/docs
generated_at: '2026-10-19T19:20:00.383283+00:00'
latest_process_ref: ''
file_count: 33
subfolder_count: 0
---

# snippets

## Self-Summary
> Runnable SDK snippets, one page per subject and each pinned by tests: agents on channels and deployments, FlowCall and ComputeOp blocks, wizards and workflows, data sources and pipes, DataSpec and datasets, connections and secrets, message channels and threads, RAG, scan and index, and project dependencies.

## Files
- [Snippets — the dev onboarding shelf](README.md) — Developer onboarding shelf index of runnable SDK snippet pages by category, each with the tests pinning it, plus channel routing notes and snippet conventions.
- [Activity — progress on anything, from anywhere](activity.md) — Activity progress API snippets: path-addressed progress nodes, counters, children, ending runs, reading state, eviction, scope, and TypeScript, CLI and HTTP equivalents.
- [Agent deployment — snippets](agent-deployment.md) — Runnable snippets for placing an Agent as a Deployment, launching sessions, reading and stopping placements, custom channel serving, and running a per-deployment local agent loop.
- [Agent email](agent-email.md) — Agent email snippet: allocating an Agent mailbox with allowed senders, then processing incoming mail through the Agent via StreamInbox and sending threaded replies.
- [Agent help desk](agent-helpdesk.md) — Giving an Agent a hub help desk as an owned message source so it answers guest tickets, with allowed-sender and pausing behavior.
- [An agent on a channel — snippets](agents-on-channels.md) — Putting an agent on a messaging channel such as WhatsApp: declaring the channel credential, app-answered versus own-loop replies, and phone-line setup.
- [Asset dependencies — snippets](asset-dependencies.md) — Asset dependency snippets: the flow.json dependencies file, layered projects, missing-link states, id lookup, Google Drive example and attaching sources to agents.
- [FlowCall — calls, outcomes, and returned values](call-returns.md) — FlowCall contract with runnable snippets: ComputeOp calls, ReturnedValue outcomes, durable calls, timeouts, human answers, wizards, agent processes, and model calls composing into structured results.
- [Channel webhooks: from WhatsApp to an agent](channel-webhook-routing.md) — Guide to routing WhatsApp channel webhooks to an agent: choosing driver and account, delivery path, account setup, group sources, delivery versus answering, and per-stage diagnosis.
- [Compute ops — one call that converges, composes, and can ask](compute-ops.md) — ComputeOp snippets: tested examples of ops that ask a person, ask once, use a ladder of attempts with one check, and handle cancel or silence.
- [Connections — Python SDK and CLI](connections.md) — Connections snippets for listing, connecting and testing OAuth providers from a Python REPL and the CLI, and requiring a held connection.
- [Data sources — snippets](data-sources.md) — Runnable code snippets for data sources: connecting and syncing feeds, deduplication, search, folder mirroring, subscriptions, replies, Google Drive connections, and writing a custom driver
- [DataSpec](data-spec.md) — Runnable snippets for DataSpec: declaring schemas, document-written schemas, call returns, save and load, file fields, identity, fields versus documents, and agent definitions as values.
- [Datasets — snippets](datasets.md) — Runnable Python dataset snippets: row schemas as data_schema folders, reading and writing rows and labels, navigator evaluation, editors, linked rows, and mirrored external data.
- [Decisions — snippets](decisions.md) — Decision snippets: closed questions answered with calibrated probabilities through a hub endpoint, acting only when sure, failure handling, TypeScript use, magic-line routing and wizard steps.
- [FlowCall blocks — typed input, call.py, output](flowcall-blocks.md) — FlowCall blocks as ComputeOps with typed input, call.py entry and ReturnedValue output, with per-variant input/output validation rules and a whole-list dedupe example.
- [Gmail source](gmail-source.md) — Gmail source setup snippet: required .env.local address and app-password variables, and Python code creating and saving a source from the shipped gmail driver.
- [LLM endpoints — snippets](llm-endpoints.md) — Snippets for LLMEndpoint kinds (api_key, hub, device): creating endpoints, listing funders, completions, embeddings, model catalogs, probes, public endpoints, and gotchas.
- [Simple message block](message-block.md) — Code example of the process-local MessageBlock for simple prompt-and-reply between a sender and an agent listener, without addresses or persistence
- [Files, quote-replies and reactions on a channel](message-channels.md) — Message channel snippets for sending files, quote-replies and reactions across WhatsApp, Telegram, Slack and email, including agent loops, reading incoming messages, and command-line use.
- [Threads and replies — one model on every channel](message-threads.md) — Runnable snippets for the threads and replies model (reply_to_id, thread_id) shared by Flowpad chat and data source channels, with channel capabilities declared as data.
- [Pipes — wiring a source to whatever consumes it](pipes.md) — Pipe snippets wiring data sources to consumers: single sync cycles, folder mirroring, change reactions, cadence, agents on several sources, RAG index upkeep, and pagination.
- [Processes and agents — snippets](processes.md) — Snippets for running agents and processes: attaching MCP servers to a process or agent across harnesses, agent-backed FlowCall composition, and typed input/output runs.
- [Project dependencies — snippets](project-dependencies.md) — Project dependency snippets: declaring git, hub or local folder dependencies in flow.json, what resolves into context, cross-project documents and agents, sharing, and equivalent verbs.
- [Project git share](project-git-share.md) — Letting project members clone and push a private GitHub repo through the hub with role-based access: sharing, member usage, unsharing, refusals, and TypeScript equivalents.
- [RAG — snippets](rag.md) — Runnable RagIndex snippets: making a folder searchable, running an embedding pass and reading its cost, asking questions, chunking without an index, and the HTTP API.
- [Relationship pickers in SDK viewers](relationship-pickers.md) — SDK relationship picker contract: ViewerHost.candidates provider shape, mountRelationshipPicker usage in create forms and inline editors, and item key, label and value semantics.
- [Scan and index — snippets](scan-and-index.md) — Runnable snippets for the flow_sdk.diskio scan and index interfaces: walking a tree, finding typed assets, reading documents, extracting links, switching Rust or Python backend.
- [Secret stores](secret-stores.md) — SecretStore and Connection snippets: the declare, check, bind pattern, store types (env_file, vault, GCP Secret Manager), and the load, save, validate and bind API.
- [Service endpoints — snippets](service-endpoints.md) — ServiceEndpoint model for deployments on compute nodes: subkinds, protocols, audience proxies routing web apps, declared exposures, and the hub control plane.
- [Stream stream inbox automations — snippets](stream-inbox-automations.md) — Stream inbox automation snippets: a tag Trigger gated by a decision op that fires a wizard when a matching message arrives, plus fire path.
- [Wizards — a sequence of calls, and what travels between them](wizards.md) — Wizard snippets for sequencing calls: step ordering, passing values between steps, fallbacks, conditional steps, declared outputs, self-calling wizards, up-front inputs, exit_error, on_fail, and shell choice.
- [Workflows — snippets](workflows.md) — Plain-Python workflow snippets using flow_sdk.blocks: a mail concierge loop, Telegram, Slack and all-channel variants, values-only usage, the opening program, and current limits.
