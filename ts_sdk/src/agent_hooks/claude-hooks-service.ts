/**
 * Claude Code hooks management service.
 * Handles CRUD operations for hooks in Claude settings files.
 */

import type { ComputeNode } from '../entities/compute-node/compute-node';
import type { HookItem } from '../entities/compute-node/system-profile';
import { JsonFileService } from '../resource_management/json-file-service';
import type {
  ClaudeSettings,
  ClaudeMatcherGroup,
  ClaudeHookEntry,
  FlowMetadata,
  HookIdentifier,
  HookOperationResult,
} from './claude-settings-types';

/**
 * Normalize a matcher value for comparison.
 * Treats '*' and empty string as equivalent (both mean "match all").
 */
function normalizeMatcher(matcher: string | undefined | null): string {
  if (matcher === '*' || matcher === undefined || matcher === null) {
    return '';
  }
  return matcher;
}

/**
 * Service for managing Claude Code hooks in settings files.
 */
export class ClaudeHooksService {
  private jsonService: JsonFileService;

  constructor(computeNode: ComputeNode) {
    this.jsonService = new JsonFileService(computeNode);
  }

  /**
   * Create a new hook in a Claude settings file.
   * @param sourceFile - Path to the settings.json file
   * @param eventType - Event type (e.g., "PreToolUse", "UserPromptSubmit")
   * @param matcher - Matcher pattern (e.g., "*", "Read", "Edit|Write")
   * @param hookEntry - The hook entry to add
   * @param flowMetadata - Optional FlowMetadata to attach (makes hook FlowPad-managed)
   * @returns Result indicating success/failure
   */
  async createHook(
    sourceFile: string,
    eventType: string,
    matcher: string,
    hookEntry: ClaudeHookEntry,
    flowMetadata?: FlowMetadata,
  ): Promise<HookOperationResult> {
    try {
      const settings = await this.jsonService.readJson<ClaudeSettings>(sourceFile);

      if (!settings.hooks) {
        settings.hooks = {};
      }

      // If flow_metadata.name is provided, remove any existing entry with the same name to prevent duplicates
      if (flowMetadata?.name) {
        for (const [evtType, groups] of Object.entries(settings.hooks)) {
          if (!Array.isArray(groups)) continue;
          for (const grp of groups) {
            grp.hooks = grp.hooks.filter((h) => h.flow_metadata?.name !== flowMetadata.name);
          }
          // Clean up empty groups
          settings.hooks[evtType] = groups.filter((g) => g.hooks.length > 0);
          if (settings.hooks[evtType].length === 0) {
            delete settings.hooks[evtType];
          }
        }
      }

      if (!settings.hooks[eventType]) {
        settings.hooks[eventType] = [];
      }

      const matcherGroups = settings.hooks[eventType];
      const normalizedMatcher = normalizeMatcher(matcher);

      // Find existing matcher group or create new one
      let group = matcherGroups.find((g) => normalizeMatcher(g.matcher) === normalizedMatcher);

      if (!group) {
        group = { matcher: matcher || undefined, hooks: [] };
        matcherGroups.push(group);
      }

      // Attach flow_metadata if provided
      const entryToAdd = flowMetadata ? { ...hookEntry, flow_metadata: flowMetadata } : hookEntry;
      group.hooks.push(entryToAdd);

      await this.jsonService.writeJson(sourceFile, settings);

      return {
        success: true,
        eventType,
        sourceFile,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to create hook',
      };
    }
  }

  /**
   * Update an existing hook by deleting the old one and creating a new one.
   * @param sourceFile - Path to the settings.json file
   * @param oldIdentifier - Identifier for the existing hook to replace
   * @param newEventType - New event type
   * @param newMatcher - New matcher pattern
   * @param newHookEntry - New hook entry
   * @param flowMetadata - Optional FlowMetadata to attach (makes hook FlowPad-managed)
   * @returns Result indicating success/failure
   */
  async updateHook(
    sourceFile: string,
    oldIdentifier: HookIdentifier,
    newEventType: string,
    newMatcher: string,
    newHookEntry: ClaudeHookEntry,
    flowMetadata?: FlowMetadata,
  ): Promise<HookOperationResult> {
    try {
      // Read settings once, do both operations in memory, write once
      const settings = await this.jsonService.readJson<ClaudeSettings>(sourceFile);

      // --- Remove old hook ---
      if (settings.hooks && settings.hooks[oldIdentifier.eventType]) {
        const matcherGroups = settings.hooks[oldIdentifier.eventType];
        const normalizedOldMatcher = normalizeMatcher(oldIdentifier.matcher);

        const groupIndex = matcherGroups.findIndex((group) => normalizeMatcher(group.matcher) === normalizedOldMatcher);

        if (groupIndex !== -1) {
          const group = matcherGroups[groupIndex];
          const hookEntryIndex = group.hooks.findIndex((h) => h.command === oldIdentifier.command);

          if (hookEntryIndex !== -1) {
            group.hooks.splice(hookEntryIndex, 1);
          }

          if (group.hooks.length === 0) {
            matcherGroups.splice(groupIndex, 1);
          }
        }

        if (matcherGroups.length === 0) {
          delete settings.hooks[oldIdentifier.eventType];
        }
      }

      // --- Add new hook ---
      if (!settings.hooks) {
        settings.hooks = {};
      }

      if (!settings.hooks[newEventType]) {
        settings.hooks[newEventType] = [];
      }

      const newMatcherGroups = settings.hooks[newEventType];
      const normalizedNewMatcher = normalizeMatcher(newMatcher);

      let targetGroup = newMatcherGroups.find((g) => normalizeMatcher(g.matcher) === normalizedNewMatcher);

      if (!targetGroup) {
        targetGroup = { matcher: newMatcher || undefined, hooks: [] };
        newMatcherGroups.push(targetGroup);
      }

      const entryToAdd = flowMetadata ? { ...newHookEntry, flow_metadata: flowMetadata } : newHookEntry;
      targetGroup.hooks.push(entryToAdd);

      // Clean up empty hooks object
      if (settings.hooks && Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }

      await this.jsonService.writeJson(sourceFile, settings);

      return {
        success: true,
        eventType: newEventType,
        sourceFile,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to update hook',
      };
    }
  }

  /**
   * Delete a hook from a Claude settings file.
   * @param hook - The HookItem to delete (from system profile scan)
   * @returns Result indicating success/failure
   */
  async deleteHook(hook: HookItem): Promise<HookOperationResult> {
    if (!hook.source_file) {
      return {
        success: false,
        error: 'No source file available for this hook',
      };
    }

    return this.deleteHookByIdentifier(hook.source_file, {
      eventType: hook.event_type,
      matcher: hook.matcher,
      command: hook.command,
    });
  }

  /**
   * Delete a hook by its identifier from a specific settings file.
   * @param sourceFile - Path to the settings.json file
   * @param identifier - Hook identifier (eventType, matcher, command)
   * @returns Result indicating success/failure
   */
  async deleteHookByIdentifier(sourceFile: string, identifier: HookIdentifier): Promise<HookOperationResult> {
    try {
      const settings = await this.jsonService.readJson<ClaudeSettings>(sourceFile);

      if (!settings.hooks || !settings.hooks[identifier.eventType]) {
        return {
          success: false,
          error: `No hooks found for event type: ${identifier.eventType}`,
        };
      }

      const matcherGroups = settings.hooks[identifier.eventType];
      const normalizedMatcher = normalizeMatcher(identifier.matcher);

      // Find the matcher group with matching matcher
      const groupIndex = matcherGroups.findIndex((group) => {
        return normalizeMatcher(group.matcher) === normalizedMatcher;
      });

      if (groupIndex === -1) {
        return {
          success: false,
          error: `No matcher group found for matcher: ${normalizedMatcher || '(empty)'}`,
        };
      }

      const group = matcherGroups[groupIndex];

      // Find the hook entry within the group's hooks array
      const hookEntryIndex = group.hooks.findIndex((h) => h.command === identifier.command);

      if (hookEntryIndex === -1) {
        return {
          success: false,
          error: 'Hook not found in settings file',
        };
      }

      // Remove the hook entry
      group.hooks.splice(hookEntryIndex, 1);

      // If no more hooks in this matcher group, remove the group
      if (group.hooks.length === 0) {
        matcherGroups.splice(groupIndex, 1);
      }

      // If no more matcher groups for this event type, remove the event type key
      if (matcherGroups.length === 0) {
        delete settings.hooks[identifier.eventType];
      }

      // If no more hooks at all, remove the hooks key
      if (settings.hooks && Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }

      // Save the updated settings
      await this.jsonService.writeJson(sourceFile, settings);

      return {
        success: true,
        eventType: identifier.eventType,
        sourceFile,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to delete hook',
      };
    }
  }

  /**
   * Get all hooks for a specific event type from a settings file.
   * @param sourceFile - Path to the settings.json file
   * @param eventType - Event type to filter by
   * @returns Array of matcher groups for the event type
   */
  async getHooksForEventType(sourceFile: string, eventType: string): Promise<ClaudeMatcherGroup[]> {
    const settings = await this.jsonService.readJson<ClaudeSettings>(sourceFile);
    return settings.hooks?.[eventType] ?? [];
  }

  /**
   * Check if a hook can be deleted (has source_file).
   * @param hook - The HookItem to check
   * @returns Whether the hook can be deleted
   */
  canDeleteHook(hook: HookItem): boolean {
    if (hook.scope === 'plugin') return false;
    return !!hook.source_file;
  }
}

/**
 * Create a ClaudeHooksService instance for a compute node.
 */
export function createClaudeHooksService(computeNode: ComputeNode): ClaudeHooksService {
  return new ClaudeHooksService(computeNode);
}
