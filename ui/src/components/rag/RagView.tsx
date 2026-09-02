/**
 * Search indexes — the folders each index covers, and what it can answer.
 *
 * The ONE editable view of coverage, and deliberately the same source of truth the tree reads:
 * both derive from `RagIndex.roots`, so removing a folder here takes the brain off that row in
 * the explorer and the docs menu without either side knowing about the other.
 *
 * Global by construction (`scope: []`), like data sources and LLM sources: an index belongs to
 * the instance, and switching project must not change what is covered.
 *
 * Counts and status are read off the row rather than polled: the background pass writes them
 * when it finishes and the live query delivers that write.
 */
import { useCallback, useMemo, useState } from 'react';
import { QueryRequest, RagIndex } from '@sdk';
import { Brain, FolderPlus, Play, Search, Trash2, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { addRoot, queryIndex, removeRoot, runIndex, type RagHit } from './rag-service';

const indexesQuery = new QueryRequest({ type: RagIndex.type, scope: [], name: 'rag:view' });

/** What the row itself says about whether it can run. Mirrors `index_refusal` on the backend. */
function statusLine(index: RagIndex): string {
  if (index.last_error) return index.last_error;
  if (index.status === 'disabled') return 'paused';
  if (!index.roots?.length) return 'covers no folders yet';
  if (index.pending) return 'changes pending';
  return index.last_indexed_at ? `indexed ${new Date(index.last_indexed_at).toLocaleString()}` : 'never indexed';
}

function RagIndexCard({ index, onChanged }: { index: RagIndex; onChanged: () => void }) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState('');
  const [hits, setHits] = useState<RagHit[] | null>(null);

  const guard = useCallback(
    async (label: string, run: () => Promise<void>) => {
      setBusy(true);
      try {
        await run();
        onChanged();
      } catch (error) {
        notify.error({ title: label, message: errorMessage(error, t`The index was not changed.`) });
      } finally {
        setBusy(false);
      }
    },
    [onChanged, t],
  );

  const drop = (path: string) =>
    guard(t`Could not stop covering ${path}`, () => removeRoot(index.id, path));

  const add = () => {
    const path = window.prompt(t`Absolute path of the folder to cover`);
    if (path?.trim()) void guard(t`Could not cover that folder`, () => addRoot(index.id, path.trim()));
  };

  const index_ = () =>
    guard(t`Could not start indexing`, async () => {
      const refusal = await runIndex(index.id);
      if (refusal) notify.error({ title: t`Nothing to index`, message: refusal });
    });

  const ask = () =>
    guard(t`The query failed`, async () => {
      const { hits: found, refusal } = await queryIndex(index.id, question, 8);
      if (refusal) notify.error({ title: t`Cannot search yet`, message: refusal });
      setHits(found);
    });

  return (
    <div data-testid={`rag-index-${index.id}`} className="rounded-lg border border-border p-4">
      <header className="mb-2 flex items-center gap-2">
        <Brain className="size-4 text-primary" />
        <span className="font-medium">{index.name || t`Default RAG`}</span>
        <span className="text-xs text-muted-foreground" data-testid="rag-status">
          {statusLine(index)}
        </span>
        <span className="ms-auto text-xs tabular-nums text-muted-foreground">
          {index.document_count} docs · {index.chunk_count} chunks
          {index.model ? ` · ${index.model}` : ''}
        </span>
      </header>

      <ul className="mb-3 space-y-1" data-testid="rag-roots">
        {(index.roots ?? []).map((root) => (
          <li key={root} className="flex items-center gap-2 text-sm" data-rag-root={root}>
            <span className="truncate font-mono text-xs">{root}</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              disabled={busy}
              title={t`Stop covering this folder`}
              data-testid={`rag-remove-root:${root}`}
              onClick={() => void drop(root)}
            >
              <X className="size-3.5" />
            </Button>
          </li>
        ))}
        {!(index.roots ?? []).length && (
          <li className="text-sm text-muted-foreground">
            <Trans>No folders yet. Add one and it will be indexed on the next pass.</Trans>
          </li>
        )}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={add} data-testid="rag-add-root">
          <FolderPlus className="me-1 size-3.5" />
          <Trans>Add folder</Trans>
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void index_()} data-testid="rag-run">
          <Play className="me-1 size-3.5" />
          <Trans>Index now</Trans>
        </Button>
        <div className="ms-auto flex items-center gap-1">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && question.trim()) void ask();
            }}
            placeholder={t`Ask this index…`}
            className="h-8 w-56"
            data-testid="rag-query-input"
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={busy || !question.trim()}
            onClick={() => void ask()}
            data-testid="rag-query-run"
          >
            <Search className="size-3.5" />
          </Button>
        </div>
      </div>

      {hits && (
        <ol className="mt-3 space-y-2" data-testid="rag-hits">
          {hits.map((hit) => (
            <li key={`${hit.doc_ref}:${hit.heading_path.join('/')}:${hit.score}`} className="text-sm">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {hit.doc_ref.split('/').pop()}
                </span>
                <span className="text-xs text-muted-foreground">{hit.heading_path.join(' / ')}</span>
                <span className="ms-auto text-xs tabular-nums">{hit.score.toFixed(3)}</span>
              </div>
              <p className="line-clamp-2 text-muted-foreground">{hit.text}</p>
            </li>
          ))}
          {!hits.length && (
            <li className="text-sm text-muted-foreground">
              <Trans>Nothing matched.</Trans>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}

export function RagView() {
  const { t } = useLingui();
  const { data: indexes = [], refetch } = useEntitiesQuery<RagIndex>(indexesQuery);
  const [creating, setCreating] = useState(false);

  const sorted = useMemo(
    () => [...indexes].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [indexes],
  );

  const create = useCallback(async () => {
    setCreating(true);
    try {
      await new RagIndex({ name: 'Default RAG' }).save();
      void refetch();
    } catch (error) {
      notify.error({ title: t`Could not create an index`, message: errorMessage(error, '') });
    } finally {
      setCreating(false);
    }
  }, [refetch, t]);

  return (
    <div data-testid="rag-view" className="flex h-full flex-col overflow-y-auto p-6">
      <header className="mb-1 flex items-center gap-2">
        <Brain className="size-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">
          <Trans>Search indexes</Trans>
        </h1>
        {indexes.length > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {indexes.length}
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ms-auto"
          disabled={creating}
          onClick={() => void create()}
          data-testid="rag-new"
        >
          <Trans>New index</Trans>
        </Button>
      </header>
      <p className="mb-5 max-w-2xl text-sm text-muted-foreground">
        <Trans>
          An index covers the folders you add and everything beneath them. Covered folders wear a
          brain in the file tree, and a folder removed here loses it.
        </Trans>
      </p>

      <div className="space-y-3">
        {sorted.map((index) => (
          <RagIndexCard key={index.id} index={index} onChanged={refetch} />
        ))}
        {!sorted.length && (
          <p className="text-sm text-muted-foreground">
            <Trans>No indexes yet.</Trans>
          </p>
        )}
      </div>
    </div>
  );
}
