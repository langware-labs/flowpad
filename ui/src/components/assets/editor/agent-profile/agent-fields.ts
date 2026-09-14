import type { Agent } from '@sdk';

export type AgentDocumentPatch = Partial<
  Pick<
    Agent,
    | 'name'
    | 'title'
    | 'description'
    | 'avatar'
    | 'worker_type'
    | 'model'
    | 'permission_mode'
    | 'effort'
    | 'max_turns'
    | 'tools'
    | 'disallowed_tools'
    | 'mcp_servers'
    | 'subagents'
    | 'additional_dirs'
    | 'load_flowpad_assistant'
    | 'cli_options'
    | 'enabled'
    | 'intro'
    | 'auto_launch'
    | 'auto_launch_prompt'
    | 'system_prompt'
  >
>;
