/**
 * Typed tool input schemas for Claude Code tools.
 */

export interface BashToolInput {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}

export interface GlobToolInput {
  pattern: string;
  path?: string;
}

export interface GrepToolInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  context?: number;
  head_limit?: number;
  multiline?: boolean;
}

export interface ReadToolInput {
  file_path: string;
  offset?: number;
  limit?: number;
  pages?: string;
}

export interface WriteToolInput {
  file_path: string;
  content: string;
}

export interface EditToolInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface TaskToolInput {
  prompt: string;
  description: string;
  subagent_type: string;
  model?: string;
  run_in_background?: boolean;
  resume?: string;
  max_turns?: number;
}

export interface WebFetchToolInput {
  url: string;
  prompt: string;
}

export interface WebSearchToolInput {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

export interface LSPToolInput {
  operation: string;
  filePath: string;
  line: number;
  character: number;
}

export interface AskUserQuestionToolInput {
  questions: Array<Record<string, unknown>>;
}

export type ToolInput =
  | BashToolInput
  | GlobToolInput
  | GrepToolInput
  | ReadToolInput
  | WriteToolInput
  | EditToolInput
  | TaskToolInput
  | WebFetchToolInput
  | WebSearchToolInput
  | LSPToolInput
  | AskUserQuestionToolInput
  | Record<string, unknown>;
