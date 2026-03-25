/**
 * Agent hooks module.
 * Provides services for managing Claude Code hooks.
 */

// Types
export type {
  ClaudeHookEntry,
  ClaudeMatcherGroup,
  ClaudeHooksConfig,
  ClaudeSettings,
  FlowMetadata,
  HookIdentifier,
  HookOperationResult,
} from './claude-settings-types';

// Service
export { ClaudeHooksService, createClaudeHooksService } from './claude-hooks-service';
