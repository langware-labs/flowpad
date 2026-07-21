import { MessageAttachment, type StagedFilesResponse } from '@sdk';
import { Trans } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MarkdownView } from '@src/components/markdown-view';

/** Strip a leading YAML frontmatter block.
 *
 *  Staged files are the RAW asset on disk (`task.md`, `SKILL.md`), so they still
 *  carry their `---`-fenced frontmatter. Handing that to a markdown renderer is
 *  actively wrong: markdown's SETEXT-heading rule reads "text followed by a line
 *  of `---`" as a heading underline, so the closing fence turns the whole
 *  `id:/title:/status:` block into one giant <h2>. The dialog header already
 *  shows the asset's name and type — the frontmatter is noise in a preview. */
function stripFrontmatter(md: string): string {
  // \uFEFF: a leading BOM would otherwise stop the fence matching at ^.
  const m = md.match(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  return m ? md.slice(m[0].length) : md;
}

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
        <MarkdownView value={stripFrontmatter(content)} compact />
      ) : (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-[12px]">
          {content}
        </pre>
      )}
      {truncated && (
        <div className="mt-2 text-[11px] italic text-muted-foreground">
          <Trans>Preview truncated.</Trans>
        </div>
      )}
    </div>
  );

  // Single content pane only — the main file (task.md / SKILL.md / …). The old
  // multi-file path rail was removed: the review dialog shows the entity's own
  // viewer for installed assets, and a bare markdown preview for staged ones.
  return <div className="max-h-[50vh] overflow-y-auto pr-1">{pane}</div>;
}
