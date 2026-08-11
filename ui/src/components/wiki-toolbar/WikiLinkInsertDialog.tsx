/**
 * WikiLinkInsertDialog — wraps the existing record-search primitives in a
 * shadcn Dialog. On selection, inserts `[[<name>]]` at the editor's cursor
 * and triggers a reindex on the source entity so getLinks() reflects the
 * new edge immediately. If the selected entity has no name, prompts the
 * user (and persists the typed name on the entity, then inserts the link).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@milkdown/core';
import { editorViewCtx } from '@milkdown/core';
import { linkSchema } from '@milkdown/preset-commonmark';
import { APIEntity, dataManager, TypeId } from '@sdk';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@src/components/ui/select';
import { useRecordSearch, type SearchFilters, type SearchResult } from '@src/hooks/use-record-search';
import { cn } from '@src/lib/utils';
import { Trans, useLingui } from '@lingui/react/macro';

const ALL_TYPES_VALUE = '__all__';

const FILTERABLE_RECORD_TYPES = [
  'skill',
  'agent',
  'workflow',
  'plan',
  'markdown',
  'task',
  'agentic_process',
  'project',
  'bookmark',
  'claude_session',
  'claude_md',
  'claude_memory',
  'claude_rules',
  'command',
  'annotation',
  'comment',
];

interface WikiLinkInsertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editorRef: React.MutableRefObject<Editor | null>;
  /**
   * Source entity TypeId (serialized form, e.g. `"plan-abc-123"`).
   * Optional — when null, insertion still happens but no immediate reindex
   * fires; the next sync_to_db will pick it up.
   */
  sourceTypeId: string | null;
  onUserEdit?: () => void;
}

type Stage =
  | { kind: 'search' }
  | { kind: 'name-prompt'; targetTypeId: TypeId };

export function WikiLinkInsertDialog({
  open,
  onOpenChange,
  editorRef,
  sourceTypeId,
  onUserEdit,
}: WikiLinkInsertDialogProps) {
  const [query, setQuery] = useState('');
  const [recordTypeFilter, setRecordTypeFilter] = useState<string>(ALL_TYPES_VALUE);
  const [stage, setStage] = useState<Stage>({ kind: 'search' });
  const [pendingName, setPendingName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useLingui();

  const filters: SearchFilters = useMemo(
    () =>
      recordTypeFilter === ALL_TYPES_VALUE
        ? {}
        : { record_type: recordTypeFilter },
    [recordTypeFilter],
  );
  const { results, isLoading } = useRecordSearch(query, filters);

  // Reset state every time the dialog re-opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setRecordTypeFilter(ALL_TYPES_VALUE);
      setStage({ kind: 'search' });
      setPendingName('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const insertWikilink = useCallback(
    (name: string) => {
      const editor = editorRef.current;
      if (!editor || !name) return;
      const href = `/dock/assets/wiki/${encodeURIComponent(name)}`;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const linkType = linkSchema.type(ctx);
        const { from, to } = view.state.selection;
        // Insert the visible text (the entity name), then apply a link mark
        // over the inserted range. ProseMirror serializes this back to
        // markdown as `[name](/dock/assets/wiki/name)` — clickable in
        // WYSIWYG, parseable by the wiki indexer (see parser.py).
        const tr = view.state.tr.insertText(name, from, to);
        tr.addMark(from, from + name.length, linkType.create({ href }));
        view.dispatch(tr);
        onUserEdit?.();
      });
    },
    [editorRef, onUserEdit],
  );

  const triggerSourceReindex = useCallback(async () => {
    if (!sourceTypeId) return;   // unindexed doc — sync_to_db will pick it up later
    try {
      const sourceTid = new TypeId(sourceTypeId);
      const sourceEntity = await dataManager.getByTypeId<APIEntity<APIEntity<unknown>>>(sourceTid);
      if (sourceEntity && typeof sourceEntity.reindex === 'function') {
        await sourceEntity.reindex();
      }
    } catch (e) {
      // Reindex is best-effort; the next save() will catch it via sync_to_db.
      console.warn('[WikiLinkInsertDialog] reindex failed:', e);
    }
  }, [sourceTypeId]);

  const finishWithName = useCallback(
    async (name: string) => {
      insertWikilink(name);
      onOpenChange(false);
      // Reindex runs in background — UX should not block on it.
      void triggerSourceReindex();
    },
    [insertWikilink, triggerSourceReindex, onOpenChange],
  );

  const handleSelect = useCallback(
    async (result: SearchResult) => {
      const existingName = result.name?.trim();
      if (existingName) {
        await finishWithName(existingName);
        return;
      }
      // No name on the search result — prompt the user. We store the typeId
      // and load the entity only at confirm-time (to set + save the name).
      const tid = new TypeId(result.record_type, result.record_id);
      setPendingName('');
      setStage({ kind: 'name-prompt', targetTypeId: tid });
    },
    [finishWithName],
  );

  const submitNamePrompt = useCallback(async () => {
    if (stage.kind !== 'name-prompt') return;
    const name = pendingName.trim();
    if (!name) return;
    try {
      const entity = await dataManager.getByTypeId<APIEntity<APIEntity<unknown>>>(stage.targetTypeId);
      if (entity) {
        (entity as { name?: string }).name = name;
        await entity.save();
        entity.markEdit();
      }
    } catch (e) {
      console.warn('[WikiLinkInsertDialog] saving entity name failed:', e);
    }
    await finishWithName(name);
  }, [stage, pendingName, finishWithName]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {stage.kind === 'search' && (
          <>
            <DialogHeader>
              <DialogTitle><Trans>Add entity link</Trans></DialogTitle>
              <DialogDescription>
                <Trans>Search any entity. Selecting one inserts a [[wikilink]] at the cursor.</Trans>
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t`Search by name…`}
                data-testid="wiki-link-search-input"
                className="flex-1"
              />
              <Select value={recordTypeFilter} onValueChange={setRecordTypeFilter}>
                <SelectTrigger className="w-40" data-testid="wiki-link-type-filter">
                  <SelectValue placeholder={t`All types`} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_TYPES_VALUE}><Trans>All types</Trans></SelectItem>
                  {FILTERABLE_RECORD_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="max-h-72 overflow-y-auto rounded-md border bg-card">
              {isLoading && query.length >= 2 && (
                <div className="px-3 py-2 text-sm text-muted-foreground"><Trans>Searching…</Trans></div>
              )}
              {!isLoading && query.length >= 2 && results.length === 0 && (
                <div className="px-3 py-2 text-sm text-muted-foreground"><Trans>No matches.</Trans></div>
              )}
              {results.slice(0, 20).map((r) => (
                <button
                  key={`${r.record_type}-${r.record_id}`}
                  type="button"
                  data-testid="wiki-link-search-result"
                  className={cn(
                    'flex w-full items-center justify-between gap-3 border-b px-3 py-2 text-left text-sm',
                    'hover:bg-muted',
                  )}
                  onClick={() => void handleSelect(r)}
                >
                  <span className="truncate">
                    {r.name || <span className="italic text-muted-foreground"><Trans>(unnamed)</Trans></span>}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{r.record_type}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {stage.kind === 'name-prompt' && (
          <>
            <DialogHeader>
              <DialogTitle><Trans>Name this entity</Trans></DialogTitle>
              <DialogDescription>
                <Trans>The selected entity has no name yet. Choose one — it will be saved to the entity AND used as the link text.</Trans>
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              value={pendingName}
              onChange={(e) => setPendingName(e.target.value)}
              placeholder={t`Entity name`}
              data-testid="wiki-link-name-input"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submitNamePrompt();
                }
              }}
            />
            <DialogFooter>
              <Button variant="ghost" onClick={() => setStage({ kind: 'search' })}>
                <Trans>Back</Trans>
              </Button>
              <Button
                disabled={!pendingName.trim()}
                onClick={() => void submitNamePrompt()}
                data-testid="wiki-link-name-confirm"
              >
                <Trans>Save & insert</Trans>
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
