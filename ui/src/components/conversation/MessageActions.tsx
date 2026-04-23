import { Download } from 'lucide-react';
import { ActionInfo } from '@sdk/models/ActionInfo';

interface MessageActionsProps {
  flowMessageId?: string;
}

function localDownloadUrl(messageId: string): string {
  return new ActionInfo('create-and-download-local-flowmsg', 'flow_message', messageId, 'GET').fullActionUrl;
}

export function MessageActions({ flowMessageId }: MessageActionsProps) {
  if (!flowMessageId) return null;

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
