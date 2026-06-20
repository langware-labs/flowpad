import { ExecutionMode } from '@sdk';
import { AlertTriangle, Bot, Globe, MessageSquare, type LucideIcon } from 'lucide-react';

/**
 * UI-layer map from ``ExecutionMode`` (defined in the TS SDK, which can't import
 * lucide) to its filter-toggle icon and human label. Same boundary as
 * ``iconRegistry.ts`` — the SDK owns the enum, the UI owns the glyphs.
 */
const MODE_ICON: Record<ExecutionMode, LucideIcon> = {
  [ExecutionMode.Interactive]: MessageSquare,
  [ExecutionMode.Background]: Bot,
  [ExecutionMode.Error]: AlertTriangle,
  [ExecutionMode.External]: Globe,
};

const MODE_LABEL: Record<ExecutionMode, string> = {
  [ExecutionMode.Interactive]: 'Interactive',
  [ExecutionMode.Background]: 'Background',
  [ExecutionMode.Error]: 'Error',
  [ExecutionMode.External]: 'External',
};

export function iconForExecutionMode(mode: string): LucideIcon {
  return MODE_ICON[mode as ExecutionMode] ?? Bot;
}

export function executionModeLabel(mode: string): string {
  return MODE_LABEL[mode as ExecutionMode] ?? mode;
}
