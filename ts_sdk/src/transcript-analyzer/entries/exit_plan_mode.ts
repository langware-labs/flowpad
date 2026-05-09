/**
 * ExitPlanModeEntry — a ToolUseEntry for the ExitPlanMode tool.
 *
 * Newer Claude Code versions emit `planFilePath` directly on the
 * ExitPlanMode tool_input. Older versions don't — callers must treat
 * absence as "not available" rather than an error.
 */

import { ToolUseEntry } from './tool_use';

export class ExitPlanModeEntry extends ToolUseEntry {
  // kind stays TOOL_USE — same as parent. Subclass discriminator on the
  // wire is `tool_name === 'ExitPlanMode'`.

  get plan_text(): string {
    return String(this.tool_input?.['plan'] ?? '');
  }

  get plan_file_path(): string {
    return String(this.tool_input?.['planFilePath'] ?? '');
  }
}
