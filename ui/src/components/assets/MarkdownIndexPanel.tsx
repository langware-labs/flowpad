/**
 * MarkdownIndexPanel — side rail rendered next to the markdown-folder list view.
 *
 * Fetches the canonical structured index from
 *   GET /api/v1/markdown-index/json?folder=<abs path>
 * and renders Self-Summary + Files + Subfolders directly from the JSON.
 * Never parses the rendered `index.md` — JSON is the source of truth.
 *
 * Gracefully shows "no index yet" when the sidecar doesn't exist; provides a
 * button to navigate to the LLM Indexers panel where the rebuild can be run.
 */

import { useEffect, useState } from 'react';
import { ListTree, FileText, FolderTree, ExternalLink, RefreshCw } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import apiClient from '@sdk/client';
import { Button } from '@src/components/ui/button';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { SideDrawer } from '@src/components/ui/side-drawer';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

interface FileEntry {
  name: string;
  rel_path: string;
  title: string;
  summary: string;
  content_hash: string;
  size_bytes: number;
}

interface SubfolderEntry {
  name: string;
  rel_path: string;
  self_summary: string;
  child_typeid: string;
  child_inputs_hash: string;
}

interface IndexMdJson {
  schema_version: 1;
  typeid: string;
  parent_ref: string;
  vault_root: string;
  folder_rel_path: string;
  folder_name: string;
  inputs_hash: string;
  template_version: number;
  prompt_version: number;
  self_summary: string;
  files: FileEntry[];
  subfolders: SubfolderEntry[];
  generated_at: string;
  latest_process_ref: string;
}

interface Props {
  folderAbsPath: string;
}

export function MarkdownIndexPanel({ folderAbsPath }: Props) {
  const { navigation } = useDockNavigation();
  const { t } = useLingui();
  const [data, setData] = useState<IndexMdJson | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'empty' | 'error'>('idle');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    apiClient
      .get(`/markdown-index/json?folder=${encodeURIComponent(folderAbsPath)}`, { signal: controller.signal })
      .then((d: unknown) => {
        if (controller.signal.aborted) return;
        setData(d as IndexMdJson);
        setState('idle');
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const status = (err as { response?: { status?: number } })?.response?.status;
        setData(null);
        setState(status === 404 ? 'empty' : 'error');
      });
    return () => controller.abort();
  }, [folderAbsPath, tick]);

  return (
    <SideDrawer
      open
      data-testid="markdown-index-panel"
      width="w-80"
      title={
        <span className="flex items-center gap-1.5">
          <ListTree className="h-4 w-4 text-muted-foreground" />
          <Trans>LLM Index</Trans>
        </span>
      }
      headerActions={
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => setTick((t) => t + 1)}
          title={t`Refresh index`}
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      }
    >
      <ScrollArea className="h-full">
        {state === 'loading' && (
          <div className="p-4 text-xs text-muted-foreground">
            <Trans>Loading…</Trans>
          </div>
        )}
        {state === 'empty' && (
          <div className="flex flex-col gap-2 p-4 text-xs">
            <p className="text-muted-foreground">
              <Trans>No LLM index for this folder yet.</Trans>
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5"
              onClick={() => navigation.openDock(DockPointer.forLlmIndexers())}
            >
              <ExternalLink className="h-3 w-3" />
              <Trans>Open LLM Indexers</Trans>
            </Button>
            <p className="text-[10px] text-muted-foreground">
              <Trans>
                Run a rebuild for this folder there; the JSON appears at <code className="ms-1">index.md.json</code> in
                this folder.
              </Trans>
            </p>
          </div>
        )}
        {state === 'error' && (
          <div className="p-4 text-xs text-destructive">
            <Trans>Failed to fetch index.md.json</Trans>
          </div>
        )}
        {data && state === 'idle' && (
          <div className="space-y-3 p-3 text-sm">
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Trans>Self-Summary</Trans>
              </h3>
              <blockquote className="mt-1 border-s-2 ps-2 text-xs italic text-foreground/80">
                {data.self_summary || (
                  <span className="text-muted-foreground">
                    <Trans>(empty)</Trans>
                  </span>
                )}
              </blockquote>
            </section>

            <section>
              <div className="flex items-baseline gap-1.5">
                <FileText className="h-3 w-3 text-muted-foreground" />
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Trans>Files</Trans>
                </h3>
                <span className="text-[10px] text-muted-foreground">({data.files.length})</span>
              </div>
              <ul className="mt-1 space-y-1">
                {data.files.map((f) => (
                  <li key={f.rel_path} className="text-xs">
                    <div className="font-medium text-foreground">{f.title || f.name}</div>
                    <div className="text-[11px] text-muted-foreground">{f.summary}</div>
                  </li>
                ))}
                {data.files.length === 0 && (
                  <li className="text-xs text-muted-foreground">
                    <Trans>No files</Trans>
                  </li>
                )}
              </ul>
            </section>

            <section>
              <div className="flex items-baseline gap-1.5">
                <FolderTree className="h-3 w-3 text-muted-foreground" />
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Trans>Subfolders</Trans>
                </h3>
                <span className="text-[10px] text-muted-foreground">({data.subfolders.length})</span>
              </div>
              <ul className="mt-1 space-y-1">
                {data.subfolders.map((s) => (
                  <li key={s.rel_path} className="text-xs">
                    <div className="font-medium text-foreground">{s.name}/</div>
                    <div className="text-[11px] text-muted-foreground">{s.self_summary}</div>
                  </li>
                ))}
                {data.subfolders.length === 0 && (
                  <li className="text-xs text-muted-foreground">
                    <Trans>No subfolders</Trans>
                  </li>
                )}
              </ul>
            </section>

            <footer className="border-t pt-2 text-[10px] text-muted-foreground">
              <div>
                typeid: <code>{data.typeid.slice(0, 32)}…</code>
              </div>
              <div>
                inputs_hash: <code>{data.inputs_hash.slice(0, 12)}…</code>
              </div>
              <div>generated: {new Date(data.generated_at).toLocaleString()}</div>
            </footer>
          </div>
        )}
      </ScrollArea>
    </SideDrawer>
  );
}
