import { GitBranch, Loader2, Save } from 'lucide-react';
import React from 'react';

/**
 * The push button's glyph: a spinner while in flight, otherwise a Save icon with
 * a small git sub-badge. Shared by the footer push button and the git-modal
 * header button so the two stay visually identical.
 */
export const GitPushIcon: React.FC<{ busy?: boolean }> = ({ busy }) =>
  busy ? (
    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
  ) : (
    <span className="relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      <Save className="h-3.5 w-3.5" />
      <GitBranch className="absolute -bottom-1 -right-1 h-2 w-2 rounded-full bg-background" strokeWidth={3} />
    </span>
  );
