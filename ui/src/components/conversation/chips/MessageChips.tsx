import { Download } from 'lucide-react';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { useChipsExclude } from './ChipsExcludeContext';
import { ChipKey } from './keys';

interface MessageChipsProps {
  flowMessageId?: string;
}

function localDownloadUrl(messageId: string): string {
  return new ActionInfo('create-and-download-local-flowmsg', 'flow_message', messageId, 'GET').fullActionUrl;
}

/**
 * Per-message chip row. Today: only the download button (preserved from
 * the prior ``MessageActions`` component). Anything already rendered by a
 * higher-level chip row (Task or Conversation) is suppressed via
 * ``ChipsExcludeContext`` — the architecture is in place even though no
 * current chip kind appears at multiple levels.
 */
export function MessageChips({ flowMessageId }: MessageChipsProps) {
  const exclude = useChipsExclude();
  if (!flowMessageId) return null;
  if (exclude.has(ChipKey.download(flowMessageId))) return null;

  return (
    <a
      href={localDownloadUrl(flowMessageId)}
      download
      title="Download message"
      className="ml-1 flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-60 transition-opacity hover:opacity-100"
    >
      <Download className="h-3 w-3" />
    </a>
  );
}
