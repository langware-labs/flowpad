const HEX_COLORS: Record<string, string> = {
  artifact: '#8b5cf6',
  deployment: '#0ea5e9',
  project: '#a855f7',
  task: '#eab308',
  user: '#6366f1',
  workspace: '#64748b',
  agentic_process: '#8b5cf6',
  markdown: '#3b82f6',
  agent: '#f59e0b',
  conversation: '#10b981',
  skill: '#10b981',
  shell: '#71717a',
  claude_session: '#3b82f6',
  spec: '#f59e0b',
  claude_md: '#84cc16',
  claude_memory: '#ec4899',
  claude_rules: '#ef4444',
  whiteboard: '#ec4899',
  bookmark: '#a855f7',
  comment: '#14b8a6',
  command: '#f43f5e',
  plan: '#d946ef',
};
const HEX_DEFAULT = '#94a3b8';

export function hexForType(type: string): string {
  return HEX_COLORS[type] ?? HEX_DEFAULT;
}
