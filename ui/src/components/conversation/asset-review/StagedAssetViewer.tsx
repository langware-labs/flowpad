import { MessageAttachment, type StagedFileInfo, type StagedFilesResponse } from '@sdk';
import { Trans } from '@lingui/react/macro';
import { FileText, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MarkdownView } from '@src/components/markdown-view';
import { cn } from '@src/lib/utils';

/**
 * Read-only viewer over the STAGED (not installed, not indexed) attachment
 * content, served by the message_attachment staged-file actions. Deliberately
 * NOT the asset editor: editors resolve an indexed entity's asset_ref and
 * would route saves into the staging dir.
 *
 * Single-doc assets render the main markdown directly; multi-file assets get
 * a slim file rail + content pane.
 */
export function StagedAssetViewer({ attachment }: { attachment: MessageAttachment }) {
  const [listing, setListing] = useState<StagedFilesResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setListing(null);
    setSelected(null);
    setError(null);
    attachment
      .listStagedFiles()
      .then((res) => {
        if (cancelled) return;
        setListing(res);
        setSelected(res.main_file ?? res.files[0]?.path ?? null);
      })
      .catch((err) => {
        console.error('[asset-review] staged file listing failed', err);
        if (!cancelled) setError('listing');
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the id, not the instance: the parent re-resolves the live MA on
    // every WS update (install/uninstall), but the staged tree never changes —
    // refetching + resetting the selection on each re-emit is pure waste.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachment.id]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoadingFile(true);
    setContent(null);
    attachment
      .readStagedFile(selected)
      .then((res) => {
        if (cancelled) return;
        setContent(res.content);
        setTruncated(res.truncated);
      })
      .catch((err) => {
        console.error('[asset-review] staged file read failed', selected, err);
        if (!cancelled) setContent(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingFile(false);
      });
    return () => {
      cancelled = true;
    };
    // attachment.id, not the instance — see the listing effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachment.id, selected]);

  if (error) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        <Trans>Staged content is unavailable — re-download the message attachments.</Trans>
      </div>
    );
  }
  if (!listing) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  const multiFile = listing.files.length > 1;
  const pane = loadingFile ? (
    <div className="flex items-center justify-center py-8 text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
    </div>
  ) : content == null ? (
    <div className="py-6 text-center text-sm text-muted-foreground">
      <Trans>Select a file to preview.</Trans>
    </div>
  ) : (
    <div className="min-w-0">
      {selected?.endsWith('.md') ? (
        <MarkdownView value={content} compact />
      ) : (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-[12px]">{content}</pre>
      )}
      {truncated && (
        <div className="mt-2 text-[11px] italic text-muted-foreground">
          <Trans>Preview truncated.</Trans>
        </div>
      )}
    </div>
  );

  if (!multiFile) return <div className="max-h-[50vh] overflow-y-auto pr-1">{pane}</div>;

  return (
    <div className="flex max-h-[50vh] min-h-0 gap-3">
      <div className="w-44 shrink-0 overflow-y-auto border-r border-border pr-2">
        {listing.files.map((f: StagedFileInfo) => (
          <button
            key={f.path}
            type="button"
            onClick={() => setSelected(f.path)}
            title={f.path}
            data-testid={`staged-file-row-${f.path}`}
            className={cn(
              'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px] transition-colors',
              selected === f.path ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50',
            )}
          >
            <FileText className="h-3 w-3 shrink-0" />
            <span className="truncate">{f.path}</span>
          </button>
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">{pane}</div>
    </div>
  );
}
