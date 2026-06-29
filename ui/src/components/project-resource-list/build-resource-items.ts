import type {
  AgentItem,
  ClaudeMdItem,
  CommandItem,
  HookItem,
  McpServerItem,
  PluginItem,
  ScanProjectResponse,
  SkillItem,
  TodoFileItem,
} from '@sdk';
import type {
  ClaudeSessionRecordData,
  ClaudeSessionStatus,
} from '@sdk/resource_management/fs_records/claude/claude-session';
import type { ProjectResourceListItem } from './ProjectResourceList';

const getScopeValue = (scope: unknown): string => {
  if (typeof scope === 'string') return scope;
  if (!scope || typeof scope !== 'object') return '';
  const record = scope as Record<string, unknown>;
  const candidate = record.value ?? record.scope ?? record.name ?? record.label;
  return typeof candidate === 'string' ? candidate : '';
};

const getScopeLabel = (scope: unknown): string => {
  const value = getScopeValue(scope).trim();
  return value || 'unknown';
};

const getSkillDockPath = (skill: SkillItem): string | undefined => {
  const rawPath = (skill.path || skill.source_file || '').replace(/\\/g, '/');
  if (!rawPath) return undefined;

  const lowerPath = rawPath.toLowerCase();
  const scope = getScopeValue(skill.scope).toLowerCase();
  const trimSkillFile = (value: string) => value.replace(/\/(skill|main)\.md$/i, '');

  if (lowerPath.includes('/.flow/system_skills/')) {
    const relative = trimSkillFile(rawPath.split('/.flow/system_skills/')[1] || '');
    return relative ? `system-skills/${relative}` : 'system-skills';
  }

  if (lowerPath.includes('/.claude/skills/')) {
    const relative = trimSkillFile(rawPath.split('/.claude/skills/')[1] || '');
    const root = scope === 'project' ? 'project-skills' : 'user-skills';
    return relative ? `${root}/${relative}` : root;
  }

  if (scope === 'plugin' || scope === 'system') return 'system-skills';
  return undefined;
};

export interface BuildResourceItemsOptions {
  plugins?: PluginItem[];
}

/**
 * Build a flat list of ProjectResourceListItem from a ScanProjectResponse.
 * Extracted from HomeLanding so both HomeLanding and QuickAccessSideBar can reuse it.
 */
export function buildResourceItems(
  resources: ScanProjectResponse | null,
  options: BuildResourceItemsOptions = {},
): ProjectResourceListItem[] {
  if (!resources) return [];

  const items: ProjectResourceListItem[] = [];

  const pushSkill = (skill: SkillItem) => {
    items.push({
      id: `skill:${skill.id}`,
      itemId: skill.id,
      name: skill.name,
      type: 'skill',
      subtitle: `${getScopeLabel(skill.scope)} skill`,
      path: skill.path || skill.source_file || undefined,
      modifiedAt: skill.modified_at,
      skillDockPath: getSkillDockPath(skill),
    });
  };

  const pushMcpServer = (server: McpServerItem) => {
    const argSummary = server.args?.length ? ` ${server.args.join(' ')}` : '';
    items.push({
      id: `mcp:${server.id}`,
      itemId: server.id,
      name: server.name,
      type: 'mcp_server',
      subtitle: `${server.command}${argSummary}`.trim(),
      path: server.path || server.source_file || undefined,
      modifiedAt: server.modified_at,
    });
  };

  const pushHook = (hook: HookItem) => {
    items.push({
      id: `hook:${hook.id}`,
      itemId: hook.id,
      name: hook.name || hook.event_type,
      type: 'hook',
      subtitle: `${hook.event_type} · ${hook.matcher || hook.command}`,
      path: hook.path || hook.source_file || undefined,
      modifiedAt: hook.modified_at,
    });
  };

  const pushCommand = (command: CommandItem) => {
    items.push({
      id: `command:${command.id}`,
      itemId: command.id,
      name: command.name,
      type: 'command',
      subtitle: `${getScopeLabel(command.scope)} command`,
      path: command.path || command.source_file || undefined,
      modifiedAt: command.modified_at,
    });
  };

  const pushAgent = (agent: AgentItem) => {
    items.push({
      id: `agent:${agent.id}`,
      itemId: agent.id,
      name: agent.name,
      type: 'agent',
      subtitle: `${getScopeLabel(agent.scope)} agent`,
      path: agent.path || agent.source_file || undefined,
      modifiedAt: agent.modified_at,
    });
  };

  const pushSession = (session: ClaudeSessionRecordData) => {
    const resolvedSessionId = session.session_id || session.id;
    // Use server-computed status; fall back to 'idle' for sessions with no
    // assistant messages (status property is added by ClaudeSessionRecord.to_dict()).
    const status: ClaudeSessionStatus = (session.status ?? 'idle') as ClaudeSessionStatus;
    items.push({
      id: `session:${session.id}`,
      itemId: session.id,
      name: session.name,
      type: 'claude_session',
      subtitle: session.last_user_message || undefined,
      path: session.cwd || undefined,
      sessionId: resolvedSessionId,
      sessionPath: session.jsonl_path || session.path || undefined,
      taskPath: session.task_path || undefined,
      messageCount: session.message_count || 0,
      status,
      modifiedAt: session.modified_at,
    });
  };

  const pushTodo = (todo: TodoFileItem) => {
    items.push({
      id: `todo:${todo.id}`,
      itemId: todo.id,
      name: todo.name,
      type: 'todo',
      subtitle: `${todo.completed_count}/${todo.entry_count} completed`,
      path: todo.path || todo.source_file || undefined,
      modifiedAt: todo.modified_at,
    });
  };

  const pushClaudeMd = (file: ClaudeMdItem) => {
    items.push({
      id: `claude-md:${file.id}`,
      itemId: file.id,
      name: file.name,
      type: 'claude_md',
      subtitle: `${getScopeLabel(file.scope)} scope`,
      path: file.path || file.source_file || undefined,
      modifiedAt: file.modified_at,
    });
  };

  const pushPlugin = (plugin: PluginItem) => {
    items.push({
      id: `plugin:${plugin.id}`,
      itemId: plugin.id,
      name: plugin.name,
      type: 'plugin',
      subtitle: `v${plugin.version}${plugin.enabled ? '' : ' · disabled'}`,
      path: plugin.path || plugin.source_file || undefined,
      modifiedAt: plugin.modified_at,
    });
  };

  (resources.skills ?? []).forEach(pushSkill);
  (resources.mcp_servers ?? []).forEach(pushMcpServer);
  (resources.hooks ?? []).forEach(pushHook);
  (resources.commands ?? []).forEach(pushCommand);
  (resources.agents ?? []).forEach(pushAgent);
  (resources.sessions ?? []).forEach(pushSession);
  (resources.todos ?? []).forEach(pushTodo);
  (resources.claude_md ?? []).forEach(pushClaudeMd);
  (options.plugins ?? []).forEach(pushPlugin);

  return items;
}
