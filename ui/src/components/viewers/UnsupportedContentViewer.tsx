import { AlertCircle } from 'lucide-react';
import { ViewContext } from '../../types/ViewContext';

export interface UnsupportedContentViewerProps {
  context: ViewContext;
}

export function UnsupportedContentViewer({ context }: UnsupportedContentViewerProps) {
  return (
    <div className="flex h-full w-full items-center justify-center p-4">
      <div className="text-center">
        <AlertCircle className="mx-auto h-12 w-12 text-muted-foreground" />
        <h3 className="mt-4 text-lg font-semibold">Unsupported Content</h3>
        {context.viewerError && <p className="mt-2 text-sm text-muted-foreground">{context.viewerError.message}</p>}
        <details className="mt-4 text-left">
          <summary className="cursor-pointer text-sm text-muted-foreground">View Context Details</summary>
          <pre className="mt-2 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(context, null, 2)}</pre>
        </details>
      </div>
    </div>
  );
}
