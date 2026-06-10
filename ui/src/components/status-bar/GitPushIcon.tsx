import { CloudUpload, Loader2 } from 'lucide-react';
import React from 'react';

/**
 * The push button's glyph: a spinner while in flight, otherwise a single
 * cloud-upload icon (the non-technical "save/push to cloud" metaphor). Shared by
 * the footer push button and the git-modal header button so the two stay
 * visually identical.
 */
export const GitPushIcon: React.FC<{ busy?: boolean }> = ({ busy }) =>
  busy ? (
    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
  ) : (
    <CloudUpload className="h-3.5 w-3.5 shrink-0" />
  );
