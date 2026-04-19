import { Download } from 'lucide-react';
import { downloadFlowMessageUrl } from '@sdk/entities/flow-message';

interface MessageActionsProps {
  flowMessageId?: string;
}

export function MessageActions({ flowMessageId }: MessageActionsProps) {
  if (!flowMessageId) return null;

  return (
    <a
      href={downloadFlowMessageUrl(flowMessageId)}
      download
      title="Download message"
      className="ml-1 flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-60 transition-opacity hover:opacity-100"
    >
      <Download className="h-3 w-3" />
    </a>
  );
}
