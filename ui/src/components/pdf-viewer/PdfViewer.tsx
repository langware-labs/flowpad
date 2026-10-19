import { AlertCircle } from 'lucide-react';
import { useDownloadUrl } from '@src/hooks/use-download-url';

/**
 * Render a .pdf inline via the backend fs `download` action URL (streams raw
 * bytes with `application/pdf` + inline disposition) using the browser's native
 * PDF renderer — no pdf.js dependency. Path resolution (vpath vs machine path,
 * project fallback) is shared with MediaViewer via useDownloadUrl.
 */
export function PdfViewer({ path }: { path: string }) {
  const { url, revision } = useDownloadUrl(path);

  if (!url) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <AlertCircle className="h-4 w-4" />
        Cannot resolve PDF source: {path}
      </div>
    );
  }
  return (
    <iframe key={revision} src={url} title="PDF" className="h-full w-full border-0 bg-background" data-testid="pdf-viewer" />
  );
}

export default PdfViewer;
