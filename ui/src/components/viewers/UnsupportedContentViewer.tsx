import { AlertCircle } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { ViewContext } from '../../types/ViewContext';

export interface UnsupportedContentViewerProps {
  context: ViewContext;
}

export function UnsupportedContentViewer({ context }: UnsupportedContentViewerProps) {
  return (
    <div className="flex h-full w-full items-center justify-center p-4">
      <div className="text-center">
        <AlertCircle className="mx-auto h-12 w-12 text-muted-foreground" />
        <h3 className="mt-4 text-lg font-semibold"><Trans>Unsupported Content</Trans></h3>
        {context.viewerError && <p className="mt-2 text-sm text-muted-foreground">{context.viewerError.message}</p>}
        <details className="mt-4 text-left">
          <summary className="cursor-pointer text-sm text-muted-foreground"><Trans>View Context Details</Trans></summary>
          <pre className="mt-2 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(context, null, 2)}</pre>
        </details>
      </div>
    </div>
  );
}
