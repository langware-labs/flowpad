# AgenticProcess interface — rendered demo

This page is a visual contract tour of the current `AgenticProcess` implementation.
It covers the backend Python entity, all 42 actions defined directly on that entity,
and the public TypeScript SDK surface.

Each block below is ordinary Markdown source using the `interface` fence. In
Flowpad's Milkdown view it becomes an **Interface / Code** card. The source chip
on each card opens the implementation at the cited line. Raw Markdown and review
surfaces intentionally keep showing the original YAML fence.

This is a local demo page, so its source origins are pinned to this checkout's
absolute root. That keeps source previews deterministic even when another
Flowpad project is active.

The first class card uses the renderer's **Methods / Properties** sub-tabs. The
grouped cards below retain callable-style parameter rows, where a row reads as
`member → signature` unless the card represents one callable directly.

## Python entity

### Persisted and reflected shape

```interface
name: AgenticProcess
description: Backend entity fields plus representative entry points. Complete Python and action method groups follow below.
properties:
  type: "\"agentic_process\""
  instruction_content: "str | null"
  asset_ref: "str | null"
  context_data:
    type: "dict[str, Any]"
    description: Process context, display history, instructions, and feature-specific metadata.
  cli_config: "dict[str, Any]"
  workdir:
    type: "str | null"
    description: Frozen with project_id after a worker session_id has been adopted.
  favorite_index: "int | null"
  status:
    type: "ProcessStatus"
    description: Stored lifecycle state; turn activity is the separate derived busy field.
  busy:
    type: "bool (derived wire field)"
    description: True while a turn is in flight; never persisted.
  worker_status:
    type: "WorkerStatus | null (derived wire field)"
    description: Vendor transcript-tail state; never persisted.
  ready_for_input: "bool (derived wire field)"
  queue: "QueueState (derived wire field)"
  supports_plan_mode: "bool (derived wire field)"
  session_id: "str | null"
  use_worker_history: bool
  shell_mode:
    type: bool
    description: false is direct PTY spawn; true is the legacy intermediary shell.
  project_id: "str | null"
  collaboration_room_id: "str | null"
  target_typeid_str: "str | null"
  exe_folder: "FSRef | null"
  input_folder: "FSRef | null"
  output_folder: "FSRef | null"
  assets_folder: "FSRef | null"
  total_cost_usd:
    type: "float | null"
    description: Derived from the transcript and not persisted.
  shell_id: "str | null"
  sidecar_shell_id: "str | null"
  connection_id:
    type: "str | null"
    description: Runtime browser connection; not persisted.
  visible:
    type: bool
    description: Tab visibility only; never the execution-transport selector.
  pty_mode:
    type: bool
    description: Durable transport intent and the sole PTY versus headless routing key.
  auto_rename: bool
  process_type: "ProcessKind | null"
  restart_required: bool
  start_failure: "str | null"
  exit_code: "int | null"
  last_started_hash: "str | null"
  last_started_snapshot: "dict[str, Any] | null"
  additional_dirs: "list[str]"
  load_flowpad_assistant: "bool | null"
  embedded_subagent_ids: "list[str]"
  embedded_asset_refs: "list[TypeId]"
  worker_type: "WorkerType | null"
  plan_path: "str | null"
  markdown_docs: "list[dict]"
  status_report: "dict | null"
methods:
  run: "async (instruction, workdir=None, **kwargs) -> RunResult"
  resume: "(session_id, workdir=None, **kwargs) -> AgenticProcess"
  start_pty: "async (instruction=None, visible=None, retry=false, session_id_override=None) -> ApiResponse"
  prompt: "async (instruction) -> Any"
  wait: "async (timeout=None) -> AgenticProcess"
  restart: "async () -> ApiResponse"
  close: "async () -> ApiResponse"
returns: AgenticProcess
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: flow_sdk/builtin/agentic_process/agentic_process.py
  line: 630
```

### Load-bearing state rules

```interface
name: AgenticProcess.invariants
description: Rules every Python, REST, and TypeScript caller must preserve.
params:
  transport: "pty_mode=true -> interactive PTY; pty_mode=false -> headless JSON stream"
  visibility: "visible controls tab chrome only"
  lifecycle: "status is stored; busy and worker_status are backend-derived projections"
  binding: "session_id freezes project_id and workdir"
  shell_exit: "exit keeps the Shell for restart; close permanently tears it down"
  writes: "backend entity/actions own state; the frontend reflects updates"
  navigation: "display show events do not replace URL-first browser navigation"
returns: "one coherent process contract"
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: flow_sdk/builtin/agentic_process/agentic_process.py
  line: 679
```

### Backend helper types

```interface
name: AgenticProcess.helper_types
description: Supporting contracts defined beside the entity or exported by its package.
params:
  AssetSource: "embedded | inline | project_dir | user_dir | workdir | additional_dir | context_dir | system | external"
  AssetUsageKind: "embedded_asset | inline_persona | transcript_file_read | skill_invoked"
  AssetUsage: "{kind, path?, entry_id?, timestamp?, label?}"
  AssetDescriptor: "{typeid, source, posix_path, source_dir?, project_id?, usage[]}"
  TranscriptSubpath: "plan | prompt | prompts | full"
  SystemInstructionAssets: "{assets_dir, instructions, claude_file}"
  PromptQueue: "{enabled, entries} file-backed FIFO"
  AgenticProcessEventName: "first_prompt"
  WorkerMode: "interactive | cli"
  ModelTier: "sm | md | lg"
  RunResult: "one-shot run result"
  StreamEvent: "streamed execution event"
  ProcessError: "typed process failure"
returns: "supporting Python contracts"
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: flow_sdk/builtin/agentic_process/agentic_process.py
  line: 142
```

## Python caller API

### Factories and discovery

```interface
name: AgenticProcess.factories
description: Class-level construction, environment checks, session adoption, and lookup.
params:
  run: "async (instruction, workdir=None, **kwargs) -> RunResult"
  is_installed: "async (worker_type=None) -> bool"
  is_logged_in: "async (worker_type=None) -> WorkerAuthResult"
  resume: "(session_id, workdir=None, **kwargs) -> AgenticProcess"
  fork: "(session_id, workdir=None, **kwargs) -> AgenticProcess"
  get_by_session_id: "async (session_id) -> AgenticProcess | null"
returns: AgenticProcess
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: flow_sdk/builtin/agentic_process/agentic_process.py
  line: 912
```

### Lifecycle and persistence

```interface
name: AgenticProcess.lifecycle
description: Start, wait, stop, restart support, persistence, and permanent teardown.
params:
  start_pty: "async (instruction=None, visible=None, retry=false, session_id_override=None) -> ApiResponse"
  start: "async (instruction=None, visible=None, retry=false) -> ApiResponse"
  exit: "async () -> ApiResponse"
  wait: "async (timeout=None) -> void"
  waitForIdle: "async (timeout=None) -> void"
  reap_if_orphaned: "async (grace_seconds=10) -> bool"
  teardown_for_tab: "async () -> void"
  close: "async () -> bool"
  rename: "async (name) -> void"
  stamp_default_name: "async () -> bool"
  save: "async (owner=None, notify=true) -> Entity"
  delete: "async () -> bool"
returns: "lifecycle transition or persisted AgenticProcess"
errors: [InvalidTransition, StartFailure, WorkerBusy]
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: flow_sdk/builtin/agentic_process/agentic_process.py
  line: 1147
```

### Turns, input, and streams

```interface
name: AgenticProcess.turns
description: One prompt contract routes through PTY or headless execution according to pty_mode.
params:
  prompt: "async (instruction) -> ApiResponse"
  input: "async (text, options=None) -> ApiResponse"
  submit: "async (instruction=None, options=None) -> ApiResponse"
  send: "async (str | bytes) -> void"
  inject: "async (message) -> void"
  stream: "(instruction) -> NotImplementedError (reserved interface)"
  stream_transcript: "async iterator (timeout=300, poll_interval=0.2)"
  end_headless_turn: "async (log_prefix) -> void"
  queue: "property -> PromptQueue"
returns: "turn acceptance or streamed output"
errors: [WorkerBusy, ProcessStopping, ProcessFailed]
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: flow_sdk/builtin/agentic_process/agentic_process.py
  line: 1991
```

### Transcript, status, and runtime

```interface
name: AgenticProcess.runtime
description: Transcript projections, worker driver access, status discovery, and runtime location.
params:
  transcript: "property -> TranscriptDescriptor | null"
  transcript_path: "property -> Path | null"
  on_transcript_change: "async (jsonl_path, entries) -> void"
  driver: "property -> WorkerDriver"
  cli_options: "property -> AgentOptions"
  cmd_line: "property -> str"
  fetch_worker_status: "async () -> WorkerStatus | null"
  get_status: "async () -> status, busy, worker_status, and readiness payload"
  is_idle: "() -> bool"
  is_running: "async () -> bool"
  shell: "async () -> Shell | null"
  get_compute_node: "async () -> ComputeNode | null"
  get_project: "async () -> Project | null"
  get_host: "async (port, redirect=true) -> host payload"
  os_status: "async () -> OS liveness payload"
  get_input_dir: "async () -> input directory payload"
  set_session_id: "async (session_id) -> void"
  adopt_worker_session: "(session_id) -> bool"
  make_turn_session_adopter: "(log_prefix) -> callback"
returns: "backend-owned runtime projection"
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: flow_sdk/builtin/agentic_process/agentic_process.py
  line: 3814
```

### Assets, context, display, and plans

```interface
name: AgenticProcess.context_and_assets
description: Process-local assets, assistant instructions, graph context, display focus, and plans.
params:
  load_skill: "async (skill) -> ApiResponse"
  load_embedded_subagent: "(subagent) -> void"
  get_agents_json: "() -> dict | null"
  embedded_assets: "property -> AssetDir | null"
  ensure_embedded_assets: "() -> AssetDir"
  instructions: "property get/set -> str | null"
  prepare_system_instruction_assets: "async () -> SystemInstructionAssets | null"
  attach_embedded_asset: "async (entity_ref) -> ApiResponse"
  detach_embedded_asset: "async (entity_ref) -> ApiResponse"
  list_embedded_assets: "async () -> ApiResponse"
  get_asset_descriptors: "async () -> list[AssetDescriptor]"
  assistant_enabled: "property -> bool"
  resolved_add_dirs: "property -> list[str]"
  enable_assistant: "() -> AgenticProcess"
  set_graph_context: "(Entity) -> AgenticProcess"
  resolve_system_instructions: "async () -> str | null"
  resolve_context_summary: "async () -> str"
  get_implicit_private_context_entities: "() -> list[TypeId]"
  pair_analysis_context: "async (owner=None) -> bool"
  on_show: "async (display payload) -> void"
  on_wizard_close: "async (wizard payload) -> result payload"
  execute_plan: "async (file_path, clear_context=false) -> ApiResponse"
  update_plan: "async (file_path) -> ApiResponse"
  on_plan_created: "async (entry) -> void"
returns: "updated process context or projected assets"
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: flow_sdk/builtin/agentic_process/agentic_process.py
  line: 4065
```

## Backend action surface

Every action uses `/api/v1/graph/agentic_process/{id}/{action}`. These five cards
contain all **42 actions defined directly on** **`AgenticProcess`**.

### Lifecycle — 9 actions

```interface
name: AgenticProcess.actions.lifecycle
description: Process creation is owned by ComputeNode; these actions operate on an existing process.
params:
  exit: "POST {} -> stopped process; Shell retained"
  switch-mode: "POST {mode: cli | interactive} -> updated transport; 409 while busy"
  restart: "POST {} -> exit plus explicit PTY retry; 409 while busy"
  self-restart: "POST {} -> {scheduled: true}"
  recover-project: "POST {} -> recovered Project"
  fork: "POST {visible?} -> sibling AgenticProcess"
  open: "POST {instruction?, visible?, session_id?, retry?} -> Shell and PTY payload"
  os-status: "GET -> OS liveness snapshot"
  close: "POST {} -> permanent worker and Shell teardown"
returns: ApiResponse
errors: ["400", "409", "500"]
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: flow_sdk/builtin/agentic_process/agentic_process.py
  line: 1581
```

### Queue, tabs, and display — 9 actions

```interface
name: AgenticProcess.actions.queue_and_display
description: Queue mutations are persisted; visibility remains independent from transport.
params:
  enqueue: "POST {prompt, source?} -> QueueState"
  dequeue: "POST {id | index} -> QueueState"
  clear-queue: "POST {} -> QueueState"
  set-queue-enabled: "POST {enabled} -> QueueState"
  set-visible: "POST {visible} -> {id, visible}"
  rename: "POST {name} -> {id, name}"
  show: "POST {typeid? | path? | port?} -> ShowTarget"
  webapp-artifacts: "POST {} -> {artifacts}"
  register-webapp-artifact: "POST {port, path, artifact_id?, name?, start_cmd?, health?, description?, show?} -> artifact deployment"
returns: ApiResponse
errors: ["400", "404"]
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: flow_sdk/builtin/agentic_process/agentic_process.py
  line: 2163
```

### Turn control — 7 actions

```interface
name: AgenticProcess.actions.turn_control
description: prompt is the streaming action; input and submit provide a transport-neutral staged-input pair.
params:
  input: "POST {text, options?} -> staged input"
  submit: "POST {instruction?, options?} -> accepted turn"
  execute: "POST {instruction, session_id?} -> accepted turn"
  prompt: "POST {message, permission_mode?} -> streamed FlowData"
  cancel-prompt: "POST {} -> cancelled CLI worker or PTY turn"
  execute-plan: "POST {file_path, clear_context?} -> plan execution request"
  update-plan: "POST {file_path} -> plan update request"
returns: ApiResponse
errors: ["400", "409", "500"]
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: flow_sdk/builtin/agentic_process/agentic_process.py
  line: 2892
```

### Transcript and assets — 9 actions

```interface
name: AgenticProcess.actions.transcript_and_assets
description: Transcript reads are stateless; asset mutations materialize process-local execution inputs.
params:
  transcript: "POST /{plan | prompts | full} -> transcript projection"
  get-plan: "POST {} -> legacy plan projection"
  get-history: "GET -> {history: FlowData[]}"
  load-embedded-subagent: "POST {asset_ref} -> loaded sub-agent"
  load-embedded-skill: "POST {asset_ref} -> loaded skill"
  attach-embedded-asset: "POST {entity_ref} -> materialized entity"
  detach-embedded-asset: "POST {entity_ref} -> detached entity"
  list-embedded-assets: "GET -> TypeId[]"
  get-assets: "GET -> {assets: AssetDescriptor[]}"
returns: ApiResponse
errors: ["400", "404"]
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: flow_sdk/builtin/agentic_process/agentic_process.py
  line: 3874
```

### Diagnostics and context — 8 actions

```interface
name: AgenticProcess.actions.diagnostics_and_context
description: Read-only diagnostics plus graph-context and additional-directory configuration.
params:
  restart-info: "GET -> loaded-versus-current launch diff"
  cmd-line: "GET -> {cmd_line}"
  status: "GET | POST -> {status, busy, worker_status, ready_for_input}"
  get-host: "GET | POST {port, redirect?} -> host payload"
  set-graph-context: "POST {graph_context_id} -> bound GraphContext"
  add-dir: "POST {path} -> additional_dirs"
  remove-dir: "POST {path} -> additional_dirs"
  input-dir: "GET -> {abs_path, compute_node_id}"
returns: ApiResponse
errors: ["400", "404"]
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: flow_sdk/builtin/agentic_process/agentic_process.py
  line: 5402
```

## TypeScript SDK

### Supporting public types

```interface
name: AgenticProcess.types
description: Exported payloads used by the class methods, reflected state, queue, display stack, and entity events.
params:
  ShowTarget: "{kind?, typeid?, type?, id?, path?, port?}"
  DisplayEntry: "ShowTarget & {shown_at?}"
  SpawnResult: "{process, shell?, workerSessionId?}"
  ProcessState: "{status: WorkerStatus}"
  AgenticProcessEventName: "FirstPrompt"
  AgenticProcessReportEventResult: "{accepted, scheduled, process_id, worker_type?, session_id, event_name, event_data, request_id?, task_name?}"
  QueueEntry: "{id, prompt, source, created_at}"
  QueueState: "{enabled, entries}"
  MarkdownDoc: "{path, name, change: create | update}"
returns: "public AgenticProcess support contracts"
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: ts_sdk/src/process/agentic-process.ts
  line: 64
```

### Reflected entity contract

```interface
name: IAgenticProcess
description: Wire-facing entity shape. Backend-derived fields are readonly and frontend mutations go through actions.
params:
  instruction_content: "string | undefined"
  asset_ref: "string | undefined"
  workdir: "string | null"
  context_data: "Record<string, unknown>"
  favorite_index: "number | null"
  status: "readonly ProcessStatus"
  busy: "readonly boolean"
  worker_status: "readonly WorkerStatus"
  session_id: "string | null"
  total_cost_usd: "number | null"
  use_worker_history: boolean
  shell_mode: boolean
  worker_type: "string | null"
  process_type: "ProcessKind | null"
  shell_id: "string | null"
  visible: boolean
  pty_mode: boolean
  supports_plan_mode: boolean
  sidecar_shell_id: "string | null"
  connection_id: "string | null"
  auto_rename: boolean
  ready_for_input: "readonly boolean"
  cli_config: "Record<string, any>"
  additional_dirs: "string[]"
  load_flowpad_assistant: "boolean | null"
  embedded_asset_refs: "TypeId[]"
  project_id: "string | null"
  collaboration_room_id: "string | null"
  target_typeid_str: "string | null"
  restart_required: boolean
  start_failure: "string | null"
  last_started_hash: "string | null"
  exe_folder: "FSRefJson | null"
  input_folder: "FSRefJson | null"
  output_folder: "FSRefJson | null"
  assets_folder: "FSRefJson | null"
  plan_path: "string | null"
  markdown_docs: "MarkdownDoc[]"
  status_report: "Record<string, unknown> | null"
  queue: "QueueState | null"
returns: AgenticProcess
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: ts_sdk/src/process/agentic-process.ts
  line: 247
```

### Launch context

```interface
name: AgenticContext
description: Frontend execution context serialized from camelCase to the backend snake_case contract.
params:
  instructions: "string | undefined"
  workdir: "string | undefined"
  envVars: "Record<string, string>"
  model: "string | undefined"
  maxThinkingTokens: "number | undefined"
  permissionMode: "PermissionMode | undefined"
  projectId: "string | undefined"
  resumeSessionId: "string | undefined"
  forkSession: "boolean | undefined"
  agentsJson: "Record<string, Record<string, unknown>>"
  chrome: "boolean | undefined"
  debug: "boolean | undefined"
  worktree: "boolean | undefined"
  additionalDirs: "string[]"
  loadFlowpadAssistant: "boolean | undefined"
  sharedContextEntities: "string[]"
  targetVfsPath: "string | undefined"
  outputFormat: "string | undefined"
  workerType: "claude_code | codex | copilot"
  processType: "ProcessKind | undefined"
  contextData: "Record<string, unknown>"
returns: "Record<string, unknown> via serializeAgenticContext"
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: ts_sdk/src/process/agentic-context.ts
  line: 37
```

```interface
name: IAgenticProcessOptions
description: AgenticContext plus the entity scopes and shell transport used by AgenticProcess.spawn.
params:
  AgenticContext: "all launch-context fields"
  scope: "TypeId[]"
  shellMode: "boolean | undefined"
returns: IAgenticProcessOptions
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: ts_sdk/src/process/agentic-context.ts
  line: 114
```

```interface
name: ISpawnWorkerOptions
description: Controls how spawn activates the entity after creation.
params:
  instruction: "string | undefined"
  headless: "boolean | undefined"
  sync: "boolean | undefined"
  workerSessionId: "string | undefined"
  visible: "boolean | undefined"
  result: "{uname?, resultType?, sourceSessionId?}"
  watchProcess: "boolean | undefined"
  ptyTimeout: "number | undefined"
returns: SpawnResult
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: ts_sdk/src/process/agentic-context.ts
  line: 124
```

### Construction and discovery

```interface
name: AgenticProcess.static
description: Public TypeScript factories and lookup helpers.
params:
  openTab: "static async (workerType, prompt?, project?, opts?) -> AgenticProcess"
  launch: "static async (opts) -> AgenticProcess"
  spawn: "static async (options, workerOptions?) -> SpawnResult"
  newHeadless: "static (fields={}) -> AgenticProcess"
  getByIdWithHistory: "static async (id) -> AgenticProcess | null"
  openRecordInTerminal: "static async (record) -> AgenticProcess"
  getByWorkerId: "static async (workerId, workerType?) -> AgenticProcess | null"
  renameById: "static async (id, name) -> void"
returns: AgenticProcess
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: ts_sdk/src/process/agentic-process.ts
  line: 428
```

### State, navigation, and runtime access

```interface
name: AgenticProcess.state_and_navigation
description: URL-first navigation targets, reflected state, runtime handles, and computed projections.
params:
  getWebAppHostUrl: "(port) -> string"
  openTerminalDock: "(extraOptions?) -> void"
  isHeadless: "getter -> boolean"
  terminalDockPointer: "getter -> DockPointerData"
  transcriptDockPointer: "getter -> DockPointerData"
  dockPointer: "getter -> DockPointerData"
  searchDockPointer: "getter -> DockPointerData"
  wasRestoredFromSession: "getter -> boolean"
  icon: "getter -> ProcessIconKey"
  status: "getter -> ProcessStatus"
  busy: "getter -> boolean"
  workerStatus: "getter -> WorkerStatus"
  cliOptions: "getter/setter -> ClaudeAgentOptions"
  ptyConnection: "getter -> PtyConnection | undefined"
  workDirVfs: "getter -> VFSPath | null"
  shellEntity: "getter -> Shell | null"
  compute_node_id: "getter -> string | null"
  compute_node_uname: "getter -> string | null"
  stackFrame: "getter -> Record<string, unknown>"
  completed: "getter -> boolean"
  error: "getter -> Error | null"
  isPrompting: "getter -> boolean"
  historyLoaded: "getter -> boolean"
  displayStack: "getter -> DisplayEntry[]"
returns: "derived SDK view of backend state"
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: ts_sdk/src/process/agentic-process.ts
  line: 403
```

### Prompting and queue

```interface
name: AgenticProcess.prompt_and_queue
description: TypeScript action wrappers for turns, cancellation, the persisted queue, and prompt-library links.
params:
  enqueue: "async (prompt, source='ui') -> void"
  dequeue: "async (idOrIndex) -> void"
  clearQueue: "async () -> void"
  setQueueEnabled: "async (enabled) -> void"
  pinPrompt: "async (text, name?) -> {promptId}"
  unpinPrompt: "async (promptId) -> void"
  linkExecutedPrompt: "async (promptId) -> void"
  prompt: "async (text, abortController?, opts?) -> void"
  setVisible: "async (visible) -> void"
  input: "async (text, options?) -> void"
  submit: "async (instruction?, options?) -> void"
  cancelPrompt: "async () -> void"
  interruptTurn: "async () -> void"
  executeInstruction: "async (instruction, options?) -> void"
  sendInput: "async (text) -> void"
  inject: "async (instruction) -> {instructionId, injectedQueueSize}"
returns: "action completion or streamed turn"
errors: [ActionError, AbortError]
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: ts_sdk/src/process/agentic-process.ts
  line: 1071
```

### Output, transcript, and events

```interface
name: AgenticProcess.output_and_events
description: Streaming output, transcript hydration, local subscriptions, and backend entity-event bridging.
params:
  shell: "async () -> Shell | null"
  printPty: "async () -> void"
  onLine: "(handler) -> unsubscribe"
  onPlan: "(options, handler) -> unsubscribe"
  getPlan: "async () -> Markdown | null"
  getPrompts: "async () -> UserMessageEntry[]"
  getTranscript: "async () -> AgentTranscript"
  output: "async generator -> FlowData"
  step: "async generator -> FlowData"
  getOutputs: "() -> readonly FlowData[]"
  appendUserMessage: "(content) -> void"
  reportEvent: "async (name, data={}) -> AgenticProcessReportEventResult"
  loadHistory: "async (options={}) -> void"
  waitForReady: "async (options={}) -> void"
  waitForComplete: "async () -> void"
  onEntityEvent: "(event, payload) -> void"
  onShow: "(handler) -> unsubscribe"
  handleFlowData: "(flowData) -> void"
returns: "stream state or unsubscribe callback"
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: ts_sdk/src/process/agentic-process.ts
  line: 1129
```

### Lifecycle

```interface
name: AgenticProcess.lifecycle.ts
description: Client lifecycle methods call backend actions and keep local Shell and event state synchronized.
params:
  wait: "async () -> void"
  exit: "async () -> void"
  recoverProject: "async () -> Project"
  close: "async () -> void"
  start: "async (options?) -> boolean"
  fork: "async (visible=false) -> AgenticProcess"
  createCollaborationRoom: "async (hostName, options?) -> CollaborationRoom"
  stop: "async () -> void"
  restart: "async () -> void"
  switchMode: "async (mode, opts?) -> void"
returns: "updated AgenticProcess lifecycle"
errors: [ActionError, WorkerBusy]
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: ts_sdk/src/process/agentic-process.ts
  line: 2337
```

### Context, assets, display, and plans

```interface
name: AgenticProcess.context_and_assets.ts
description: SDK wrappers for process-local configuration, assets, display focus, and plan workflows.
params:
  enableAssistant: "async () -> this"
  setAssistantEnabled: "async (enabled) -> this"
  addDir: "async (path) -> void"
  removeDir: "async (path) -> void"
  setGraphContext: "async (graphContextId) -> void"
  show: "async ({typeid? | path? | port?}) -> void"
  loadEmbeddedSubagent: "async (sourcePath) -> void"
  loadEmbeddedSkill: "async (sourcePath) -> void"
  getAssets: "async () -> AssetDescriptor[]"
  embeddedAssets.attach: "async (entity | TypeId | string) -> void"
  embeddedAssets.detach: "async (entity | TypeId | string) -> void"
  embeddedAssets.list: "() -> TypeId[]"
  executePlan: "async (filePath, options?) -> void"
  updatePlan: "async (filePath) -> void"
returns: "updated reflected entity or requested plan operation"
source:
  origin:
    kind: local
    base: /Users/shlom/Documents/dev/flowpad-oss
    rel_path: ts_sdk/src/process/agentic-process.ts
  line: 1004
```

## Reading the cards

* **Interface** shows the rendered contract.

* **Code** is the fully editable YAML stored in this Markdown file when the
  document is in Editor mode; View mode keeps it read-only.

* YAML is parsed and schema-validated as it changes. An error stays visible
  below the active pane while the last good Interface render is preserved.

* Moving the caret into a fence forces Code mode so edits never happen invisibly.

* In editable mode, names, types, signatures, optional flags, and existing
  descriptions can be edited inline and are committed back through a normal
  ProseMirror transaction. Structural changes belong in Code.

* The source chip is read-only navigation: it remains available even when this
  document itself is in view mode.

The architectural narrative remains in
[`docs/interface/agentic-process.md`](../interface/agentic-process.md); this page
is intentionally the visual, source-grounded demo.

<!-- flowpad:capsule identity
version: 1
data:
  id: 6f04c78e-637e-4d6a-9c2a-a546bd32cea2
flowpad:endcapsule identity -->
