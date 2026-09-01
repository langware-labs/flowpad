import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

/**
 * Localized names for entity TYPES.
 *
 * The backend type registry stays the authority for a type's presentation —
 * `TypeInfo.display_name` (or the generic title-caser) is what an English UI
 * shows, and it is still the fallback here. What the registry cannot ship is a
 * translation: it speaks one language, so every per-type word it hands the
 * frontend ("Task", "Skills", "Documents") arrived on a Hebrew screen in
 * English, sitting next to `<Trans>`-wrapped copy that had been translated.
 * That is the whole reason a Hebrew project page read half-translated.
 *
 * So this is a translation layer, NOT a second source of truth: it maps a type
 * to a Lingui message whose SOURCE TEXT is the registry's own English wording,
 * which keeps the two in step and lets `lingui extract` see the strings. A type
 * absent from the map — a new one, or one the backend added since — falls
 * through to the registry label unchanged, so the failure mode is "still
 * English", never a wrong word.
 *
 * Keyed by TYPE rather than by the English string: the thing being named is the
 * type, and keying on the label would make two unrelated types that happen to
 * share a word share a translation.
 *
 * Note the singular/plural forms are the registry's, not ours — `skill` is
 * "Skills" because that is what its `TypeInfo` calls it (it labels a section),
 * while `task` is "Task". Translations must follow the same number.
 *
 * Regenerate the entries from a running backend's `/api/v1/graph/bootstrap`
 * `types` payload when new types ship.
 */
const TYPE_LABELS: Record<string, MessageDescriptor> = {
  agent: msg`Agents`,
  agent_hook: msg`Agent Hook`,
  agent_trace: msg`Agent Trace`,
  agentic_process: msg`Agentic Process`,
  annotation: msg`Annotation`,
  api_key: msg`Api Key`,
  artifact: msg`Artifacts`,
  asset_cleanup_report: msg`Asset Cleanup Report`,
  bookmark: msg`Bookmark`,
  capability: msg`Capability`,
  claude_hook: msg`Claude Hook`,
  claude_md: msg`Claude Md`,
  claude_memory: msg`Claude Memory`,
  claude_rules: msg`Claude Rules`,
  claude_session: msg`Claude Session`,
  code_ref: msg`Code Ref`,
  codex_session: msg`Codex Session`,
  collaboration_room: msg`Collaboration Room`,
  command: msg`Command`,
  comment: msg`Comment`,
  compute_node: msg`Compute Node`,
  contact_permission: msg`Contact Permission`,
  contacts_group: msg`Contacts Group`,
  conversation: msg`Conversation`,
  copilot_session: msg`Copilot Session`,
  cron_event: msg`Cron Event`,
  data_source: msg`Data sources`,
  data_source_cursor: msg`Data Source Cursor`,
  dataset: msg`Dataset`,
  deck: msg`Decks`,
  deck_template: msg`Deck Template`,
  deployment: msg`Deployments`,
  dynamic_workflow: msg`Dynamic Workflow`,
  feed_entry: msg`Feed Entry`,
  file: msg`File`,
  flow_message: msg`Flow Message`,
  flowpad_diagnosis: msg`Flowpad Diagnosis`,
  folder: msg`Folder`,
  graph_context: msg`Graph Context`,
  graph_workflow: msg`Graph Workflows`,
  graph_workflow_node: msg`Graph Workflow Node`,
  graph_workflow_run: msg`Graph Workflow Run`,
  group: msg`Group`,
  helpdesk: msg`Help desks`,
  inbox_manager: msg`Inbox Manager`,
  invitation: msg`Invitation`,
  journey: msg`Journeys`,
  journey_journal: msg`Journey Journal`,
  knowledge_base: msg`Knowledge Base`,
  llm_endpoint: msg`LLM Endpoint`,
  markdown: msg`Documents`,
  markdown_index: msg`Markdown Index`,
  mcp: msg`MCP`,
  mcp_server: msg`Mcp Server`,
  message_attachment: msg`Message Attachment`,
  message_suggest: msg`Message Suggest`,
  message_thread: msg`Message Thread`,
  micro_app: msg`Apps`,
  notification: msg`Notification`,
  organization: msg`Organization`,
  plan: msg`Plan`,
  plugin: msg`Plugin`,
  process_result: msg`Process Result`,
  project: msg`Project`,
  prompt: msg`Prompt`,
  prompt_completion: msg`Prompt Completion`,
  remote_worker_session: msg`Remote Worker Session`,
  secret_origin: msg`Secret Origin`,
  shell: msg`Shell`,
  skill: msg`Skills`,
  source_item: msg`Source Item`,
  spec: msg`Spec`,
  spreadsheet: msg`Spreadsheets`,
  subagent: msg`Sub-agents`,
  tab: msg`Tab`,
  tag: msg`Tags`,
  task: msg`Task`,
  team: msg`Team`,
  todo_file: msg`Todo File`,
  trigger: msg`Trigger`,
  usage_report: msg`Usage Report`,
  user: msg`User`,
  user_note: msg`User Note`,
  visitor: msg`Visitor`,
  whiteboard: msg`Whiteboards`,
  wiki: msg`Wikis`,
  wiki_entry: msg`Wiki Entries`,
  workflow_run: msg`Workflow Run`,
  workspace: msg`Workspace`,
};

/**
 * Translate a type's display label, falling back to the registry's English.
 *
 * `fallback` is what the caller already resolved from the backend registry, so
 * an unmapped type keeps exactly the wording it has today.
 */
export function translateTypeLabel(type: string, fallback: string): string {
  const descriptor = TYPE_LABELS[type];
  return descriptor ? i18n._(descriptor) : fallback;
}
