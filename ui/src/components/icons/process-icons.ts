import { History, Sparkles } from 'lucide-react';
import type { ComponentType } from 'react';
import type { ProcessIconKey } from '@sdk';
import { ClaudeIcon } from './ClaudeIcon';
import { ClaudeRestoreIcon } from './ClaudeRestoreIcon';
import { CodexIcon } from './CodexIcon';
import { CodexRestoreIcon } from './CodexRestoreIcon';
import { CopilotIcon } from './CopilotIcon';
import { CopilotRestoreIcon } from './CopilotRestoreIcon';
import { OpenCodeIcon } from './OpenCodeIcon';
import { OpenCodeRestoreIcon } from './OpenCodeRestoreIcon';

/**
 * UI-side resolver for the symbolic ``ProcessIconKey`` exposed by
 * ``AgenticProcess.processIconKey``. The SDK can't import React components, so it
 * publishes a key and the UI plugs the right glyph in here.
 *
 * Add new vendor pairs (fresh + restored) as worker types appear.
 */
export const PROCESS_ICONS: Record<ProcessIconKey, ComponentType<{ className?: string }>> = {
  claude: ClaudeIcon,
  'claude-restore': ClaudeRestoreIcon,
  codex: CodexIcon,
  'codex-restore': CodexRestoreIcon,
  copilot: CopilotIcon,
  'copilot-restore': CopilotRestoreIcon,
  opencode: OpenCodeIcon,
  'opencode-restore': OpenCodeRestoreIcon,
  generic: Sparkles,
  'generic-restore': History,
};

/** Convenience: resolve an icon key to its component. */
export function pickProcessIcon(key: ProcessIconKey): ComponentType<{ className?: string }> {
  return PROCESS_ICONS[key] ?? ClaudeIcon;
}
