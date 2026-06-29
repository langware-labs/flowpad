import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Textarea } from '@src/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { FileText, Info, MessageSquare, StickyNote, Tag } from 'lucide-react';
import { useDockNavigation } from '@src/navigation';
import { APIEntity } from '@sdk/APIEntity';
import { useContext } from '@sdk/react/hooks';
import React, { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AnnotationElement, AnnotationElementKind } from './use-annotation-gutter';

interface AnnotationGutterProps {
  elements: AnnotationElement[];
  viewportY: number;
  rows: number;
  cellHeight: number;
  scrollToLine: (absoluteLine: number) => void;
  createBookmark: (absoluteLine: number, content: string) => Promise<void>;
  createComment: (absoluteLine: number, content: string) => Promise<void>;
  deleteBookmark: (element: AnnotationElement) => Promise<void>;
  onHoverRow?: (absRow: number | null) => void;
  hideCounter?: boolean;
}

const GUTTER_WIDTH = 24;

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getElementIcon(kind: AnnotationElementKind) {
  if (kind === 'bookmark') return StickyNote;
  if (kind === 'comment') return MessageSquare;
  if (kind === 'plan') return FileText;
  return Tag;
}

function getElementColor(kind: AnnotationElementKind): string {
  if (kind === 'bookmark') return 'text-yellow-400';
  if (kind === 'comment') return 'text-sky-400';
  if (kind === 'plan') return 'text-blue-400';
  return 'text-lime-400';
}

function getElementLabel(kind: AnnotationElementKind): string {
  if (kind === 'bookmark') return 'Bookmark';
  if (kind === 'comment') return 'Comment';
  if (kind === 'plan') return 'Plan';
  return 'Prompt';
}

function getElementSnippet(el: AnnotationElement): string {
  if (el.kind === 'bookmark') return el.bookmark?.content || 'Untitled';
  return el.annotation?.content || getElementLabel(el.kind);
}

/** Tooltip label with an explanatory title for debug coord fields. */
function CoordLabel({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted decoration-muted-foreground/60 underline-offset-2">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-[220px] text-[10px]">
        {title}
      </TooltipContent>
    </Tooltip>
  );
}

/** Hover tooltip body shown above an annotation gutter icon. */
function AnnotationTooltipBody({ group }: { group: AnnotationElement[] }) {
  if (group.length === 0) {
    return <span className="text-xs"><Trans>Click to add annotation</Trans></span>;
  }

  const items = group.length <= 3 ? group : [...group.slice(-2)];
  const hiddenCount = group.length - items.length;

  return (
    <div className="space-y-1.5">
      {hiddenCount > 0 && (
        <p className="text-[10px] text-primary-foreground/60"><Trans>+{hiddenCount} more…</Trans></p>
      )}
      {items.map((el, i) => {
        const Icon = getElementIcon(el.kind);
        const color = getElementColor(el.kind);
        const label = getElementLabel(el.kind);
        const content = el.kind === 'bookmark' ? el.bookmark?.content : el.annotation?.content;
        const ts = el.kind === 'bookmark' ? el.bookmark?.created_date : el.annotation?.iso_timestamp;
        const sessionId = el.annotation?.session_id;
        const dataLine = (el.kind === 'bookmark' ? el.bookmark?.data?.line : el.annotation?.data?.line) as number | undefined;
        const seq = el.bookmark?.data?.seq as number | undefined;
        const seqOffset = el.bookmark?.data?.seqOffset as number | undefined;
        const filePath = el.kind === 'plan'
          ? (el.annotation?.data as Record<string, unknown>)?.file_path as string | undefined
          : undefined;

        return (
          <div key={el.bookmark?.id ?? el.annotation?.id ?? i} className="space-y-1">
            {i > 0 && <div className="border-t border-primary-foreground/20" />}
            {/* Header row: kind icon + label + line */}
            <div className="flex items-center gap-1.5">
              <Icon className={cn('h-3 w-3 shrink-0', color)} />
              <span className="text-[10px] font-semibold text-primary-foreground">{label}</span>
              <span className="ml-auto font-mono text-[10px] text-primary-foreground/70"><Trans>line {el.absRow}</Trans></span>
            </div>
            {/* Content preview */}
            {content && (
              <p className="max-w-[220px] text-[11px] font-medium text-primary-foreground/90">{content}</p>
            )}
            {/* Positioning correlation info */}
            <div className="rounded border border-primary-foreground/20 bg-primary-foreground/10 px-1.5 py-1 font-mono text-[9px] leading-relaxed space-y-0.5">
              {dataLine !== undefined && (
                <div className="flex justify-between gap-3">
                  <span className="text-primary-foreground/60"><Trans>stored line</Trans></span>
                  <span className="text-primary-foreground">{dataLine}{dataLine !== el.absRow ? <span className="ml-1 text-yellow-400"><Trans>→ {el.absRow} (drifted)</Trans></span> : null}</span>
                </div>
              )}
              {seq !== undefined && (
                <div className="flex justify-between gap-3">
                  <span className="text-primary-foreground/60"><Trans>anchor</Trans></span>
                  <span className="text-primary-foreground">seq {seq} Δ {(seqOffset ?? 0) >= 0 ? `+${seqOffset ?? 0}` : seqOffset ?? 0}</span>
                </div>
              )}
              {ts && (
                <div className="flex justify-between gap-3">
                  <span className="text-primary-foreground/60"><Trans>created</Trans></span>
                  <span className="text-primary-foreground">{fmtDate(ts)} <span className="text-primary-foreground/60">({relTime(ts)})</span></span>
                </div>
              )}
              {sessionId && (
                <div className="flex justify-between gap-3">
                  <span className="text-primary-foreground/60"><Trans>session</Trans></span>
                  <span className="truncate max-w-[120px] text-primary-foreground" title={sessionId}>{sessionId.slice(0, 8)}…</span>
                </div>
              )}
              {filePath && (
                <div className="flex justify-between gap-3">
                  <span className="text-primary-foreground/60"><Trans>plan file</Trans></span>
                  <span className="truncate max-w-[120px] text-primary-foreground">{filePath.split('/').pop()}</span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const AnnotationGutter = React.memo(function AnnotationGutter({
  elements,
  viewportY,
  rows,
  cellHeight,
  scrollToLine,
  createBookmark,
  createComment,
  deleteBookmark,
  onHoverRow,
  hideCounter = false,
}: AnnotationGutterProps) {
  if (cellHeight <= 0) return null;

  // Build rowGroups for visible viewport
  const rowGroupMap = new Map<number, AnnotationElement[]>();
  for (const el of elements) {
    const row = el.absRow - viewportY;
    if (row < 0 || row >= rows) continue;
    const group = rowGroupMap.get(row) ?? [];
    group.push(el);
    rowGroupMap.set(row, group);
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div data-testid="annotation-gutter" className="relative shrink-0" style={{ width: GUTTER_WIDTH, height: rows * cellHeight }}>
        {!hideCounter && (
          <AnnotationIndexSquare
            elements={elements}
            scrollToLine={scrollToLine}
          />
        )}
        {Array.from({ length: rows }, (_, r) => {
          const absoluteLine = viewportY + r;
          const group = rowGroupMap.get(r) ?? [];
          return (
            <AnnotationCell
              key={absoluteLine}
              row={r}
              cellHeight={cellHeight}
              absoluteLine={absoluteLine}
              group={group}
              createBookmark={createBookmark}
              createComment={createComment}
              deleteBookmark={deleteBookmark}
              onHoverRow={onHoverRow}
            />
          );
        })}
      </div>
    </TooltipProvider>
  );
});

/** Count badge + click → popup list of all annotations with scroll-to navigation. */
export function AnnotationIndexSquare({
  elements,
  scrollToLine,
  triggerClassName,
}: {
  elements: AnnotationElement[];
  scrollToLine: (absoluteLine: number) => void;
  triggerClassName?: string;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { agenticProcessTypeId } = useContext();
  const [open, setOpen] = useState(false);
  const total = elements.length;

  const bookmarkCount = elements.filter(e => e.kind === 'bookmark').length;
  const commentCount = elements.filter(e => e.kind === 'comment').length;
  const promptCount = elements.filter(e => e.kind === 'prompt').length;

  const tooltipParts: string[] = [];
  if (bookmarkCount > 0) tooltipParts.push(`${bookmarkCount} bookmark${bookmarkCount === 1 ? '' : 's'}`);
  if (commentCount > 0) tooltipParts.push(`${commentCount} comment${commentCount === 1 ? '' : 's'}`);
  if (promptCount > 0) tooltipParts.push(`${promptCount} prompt${promptCount === 1 ? '' : 's'}`);
  const tooltipText = total === 0 ? t`No annotations yet` : tooltipParts.join(', ');

  const defaultTriggerClass = "absolute left-1/2 top-0 z-10 flex -translate-x-1/2 cursor-pointer items-center justify-center rounded bg-muted/60 hover:bg-muted";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          className={triggerClassName ?? defaultTriggerClass}
          style={triggerClassName ? undefined : { width: GUTTER_WIDTH, height: 18 }}
          title={tooltipText}
        >
          <span className="font-mono font-semibold leading-none text-muted-foreground" style={{ fontSize: 10 }}>
            {total}
          </span>
        </div>
      </PopoverTrigger>
      <PopoverContent side="left" align="start" className="w-56 p-1.5">
        <p className="mb-1 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Trans>Annotations</Trans>
        </p>
        {total === 0 ? (
          <p className="px-1.5 py-1 text-xs text-muted-foreground"><Trans>No annotations yet</Trans></p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {elements.map((el, i) => {
              const Icon = getElementIcon(el.kind);
              const color = getElementColor(el.kind);
              const line = el.bookmark?.data?.line as number | undefined
                ?? el.annotation?.data?.line as number | undefined;
              const planFilePath = el.kind === 'plan'
                ? (el.annotation?.data as Record<string, unknown>)?.file_path as string | undefined
                : undefined;
              return (
                <button
                  key={el.bookmark?.id ?? el.annotation?.id ?? i}
                  type="button"
                  className="flex w-full items-start gap-1.5 rounded px-1.5 py-1 text-left hover:bg-accent"
                  onClick={() => {
                    if (planFilePath && agenticProcessTypeId) {
                      navigation.openPlan(agenticProcessTypeId, planFilePath);
                    } else if (line !== undefined) {
                      scrollToLine(line);
                    }
                    setOpen(false);
                  }}
                >
                  <Icon className={cn('mt-px h-3 w-3 shrink-0', color)} />
                  <span className="truncate text-xs text-foreground">
                    {getElementSnippet(el)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

interface AnnotationCellProps {
  row: number;
  cellHeight: number;
  absoluteLine: number;
  group: AnnotationElement[];
  createBookmark: (absoluteLine: number, content: string) => Promise<void>;
  createComment: (absoluteLine: number, content: string) => Promise<void>;
  deleteBookmark: (element: AnnotationElement) => Promise<void>;
  onHoverRow?: (absRow: number | null) => void;
}

function AnnotationCell({
  row,
  cellHeight,
  absoluteLine,
  group,
  createBookmark,
  createComment,
  deleteBookmark,
  onHoverRow,
}: AnnotationCellProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { agenticProcessTypeId } = useContext();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  // For empty rows: which type to create (null = type picker menu)
  const [createType, setCreateType] = useState<'bookmark' | 'comment' | null>(null);
  // For multi-element rows: which element's detail is open (null = selection menu)
  const [selectedEl, setSelectedEl] = useState<AnnotationElement | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showCoords, setShowCoords] = useState(false);

  const isEmpty = group.length === 0;
  const isSingle = group.length === 1;
  const isMulti = group.length > 1;

  // Primary element to show icon for (last in group = most recent)
  const primaryEl = group[group.length - 1];

  const handleOpenChange = (val: boolean) => {
    setOpen(val);
    if (!val) {
      setText('');
      setCreateType(null);
      setSelectedEl(null);
      setConfirmDelete(false);
      setShowCoords(false);
    }
  };

  const handleSave = async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      if (createType === 'comment') {
        await createComment(absoluteLine, text.trim());
      } else {
        await createBookmark(absoluteLine, text.trim());
      }
      setOpen(false);
      setText('');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (el: AnnotationElement) => {
    await deleteBookmark(el);
    setOpen(false);
    setConfirmDelete(false);
  };

  // Render icon for the trigger button
  const renderTriggerIcon = () => {
    if (isEmpty) {
      return (
        <div className="flex h-4 w-4 items-center justify-center rounded border-2 border-yellow-400/80 bg-yellow-400/15 font-mono text-[9px] font-bold leading-none text-yellow-400/80">+</div>
      );
    }
    const Icon = getElementIcon(primaryEl.kind);
    const color = getElementColor(primaryEl.kind);
    return (
      <div className="relative">
        <Icon className={cn('h-4 w-4', color)} />
        {isMulti && (
          <span className="absolute -right-1.5 -top-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-muted text-[8px] font-bold leading-none text-foreground">
            {group.length}
          </span>
        )}
      </div>
    );
  };

  // Popover content
  const renderPopoverContent = () => {
    // Empty row: type picker → form
    if (isEmpty) {
      // Type picker menu
      if (createType === null) {
        return (
          <div className="flex flex-col gap-1">
            <p className="mb-0.5 px-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"><Trans>Add annotation</Trans></p>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded px-2 py-2 text-left hover:bg-accent"
              onClick={() => setCreateType('bookmark')}
            >
              <StickyNote className="h-4 w-4 shrink-0 text-yellow-400" />
              <div className="flex flex-col">
                <span className="text-xs font-medium"><Trans>Bookmark</Trans></span>
                <span className="text-[10px] text-muted-foreground"><Trans>Personal note, actionable item</Trans></span>
              </div>
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded px-2 py-2 text-left hover:bg-accent"
              onClick={() => setCreateType('comment')}
            >
              <MessageSquare className="h-4 w-4 shrink-0 text-sky-400" />
              <div className="flex flex-col">
                <span className="text-xs font-medium"><Trans>Comment</Trans></span>
                <span className="text-[10px] text-muted-foreground"><Trans>Inline remark on this line</Trans></span>
              </div>
            </button>
          </div>
        );
      }

      // Creation form (bookmark or comment)
      const isComment = createType === 'comment';
      const FormIcon = isComment ? MessageSquare : StickyNote;
      const formIconColor = isComment ? 'text-sky-400' : 'text-yellow-400';
      const formLabel = isComment ? t`Add Comment` : t`Add Bookmark`;
      const formPlaceholder = isComment ? t`Type a comment...` : t`Type a note...`;
      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => { setCreateType(null); setText(''); }}
            >
              ←
            </button>
            <FormIcon className={cn('h-4 w-4 shrink-0', formIconColor)} />
            <span className="text-xs font-medium">{formLabel}</span>
          </div>
          <Textarea
            rows={3}
            autoFocus
            placeholder={formPlaceholder}
            className="resize-none text-sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void handleSave();
            }}
          />
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setOpen(false)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={!text.trim() || saving}
              onClick={() => void handleSave()}
            >
              <Trans>Save</Trans>
            </Button>
          </div>
        </div>
      );
    }

    // Single element: show detail directly
    if (isSingle) {
      return renderElementDetail(group[0]);
    }

    // Multiple elements: show selection menu unless one is selected
    if (selectedEl) {
      return (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => { setSelectedEl(null); setConfirmDelete(false); setShowCoords(false); }}
          >
            <Trans>← Back</Trans>
          </button>
          {renderElementDetail(selectedEl)}
        </div>
      );
    }

    // Selection menu
    return (
      <div className="flex flex-col gap-0.5">
        <p className="mb-1 px-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Trans>{group.length} annotations on this row</Trans>
        </p>
        {group.map((el, i) => {
          const Icon = getElementIcon(el.kind);
          const color = getElementColor(el.kind);
          return (
            <button
              key={el.bookmark?.id ?? el.annotation?.id ?? i}
              type="button"
              className="flex w-full items-start gap-1.5 rounded px-1.5 py-1.5 text-left hover:bg-accent"
              onClick={() => setSelectedEl(el)}
            >
              <Icon className={cn('mt-px h-3.5 w-3.5 shrink-0', color)} />
              <div className="flex flex-col">
                <span className="text-[10px] font-medium text-muted-foreground">{getElementLabel(el.kind)}</span>
                <span className="truncate text-xs text-foreground">{getElementSnippet(el)}</span>
              </div>
            </button>
          );
        })}
      </div>
    );
  };

  const renderElementDetail = (el: AnnotationElement) => {
    if (el.kind === 'bookmark') {
      return renderBookmarkDetail(el);
    }
    if (el.kind === 'comment') {
      return renderCommentDetail(el);
    }
    if (el.kind === 'plan') {
      return renderPlanDetail(el);
    }
    return renderPromptDetail(el);
  };

  const renderBookmarkDetail = (el: AnnotationElement) => {
    const bookmark = el.bookmark!;
    const storedLine = bookmark.data?.line as number | undefined;
    const seq = bookmark.data?.seq as number | undefined;
    const seqOffset = bookmark.data?.seqOffset as number | undefined;
    const absRow = el.absRow;
    const bufferPx = absRow * cellHeight;
    const viewportPx = row * cellHeight;
    const rowDrifted = storedLine !== undefined && storedLine !== absRow;
    const sign = (n: number) => n >= 0 ? `+${n}` : String(n);
    const viewportTopRow = absoluteLine - row;
    const created = bookmark.created_date;

    const infoButton = (
      <button
        type="button"
        className={cn('ml-auto flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-foreground', showCoords && 'text-foreground')}
        title={t`Show coordinates`}
        onClick={() => setShowCoords((v) => !v)}
      >
        <Info className="h-3.5 w-3.5" />
      </button>
    );

    const coordsPanel = (
      <div className="rounded border border-border bg-muted/60 px-2 py-1.5 font-mono text-[10px] leading-relaxed">
        {created && (
          <div className="mb-0.5 text-foreground">
            {fmtDate(created)}
            <span className="ml-1.5 text-muted-foreground">({relTime(created)})</span>
          </div>
        )}
        <div className="my-0.5 border-t border-border" />
        <div className="flex justify-between">
          <CoordLabel title="Absolute row index in the terminal scroll buffer (0 = top of all output)"><Trans>buffer row</Trans></CoordLabel>
          <span className="text-foreground">
            {rowDrifted
              ? <>{storedLine} <span className="text-muted-foreground"><Trans>stored →</Trans></span> <span className="text-yellow-400">{absRow} <Trans>live</Trans></span></>
              : absRow}
          </span>
        </div>
        <div className="flex justify-between">
          <CoordLabel title="PTY write-sequence anchor: seq = write sequence number, Δ = row offset from that write. Used for scroll-stable positioning when buffer scrolls."><Trans>anchor</Trans></CoordLabel>
          <span className="text-foreground">
            {seq !== undefined
              ? <>seq {seq} <span className="text-muted-foreground">Δ</span> {sign(seqOffset ?? 0)}</>
              : <span className="text-muted-foreground"><Trans>line fallback</Trans></span>}
          </span>
        </div>
        <div className="flex justify-between">
          <CoordLabel title="Row index within the currently visible viewport (0 = top visible row). viewportTopRow shows the absolute buffer row at the top of the viewport."><Trans>viewport row</Trans></CoordLabel>
          <span className="text-foreground">{row} <span className="text-muted-foreground">of [{viewportTopRow}…]</span></span>
        </div>
        <div className="my-0.5 border-t border-border" />
        <div className="flex justify-between">
          <CoordLabel title="Pixel Y offset from the top of the full scroll buffer (absRow × cellHeight). Used for absolute positioning overlays."><Trans>buffer px</Trans></CoordLabel>
          <span className="text-foreground">{absRow} × {cellHeight} = {bufferPx}px</span>
        </div>
        <div className="flex justify-between">
          <CoordLabel title="Pixel Y offset from the top of the visible viewport (viewportRow × cellHeight). Used for placing UI elements relative to the current view."><Trans>viewport px</Trans></CoordLabel>
          <span className="text-foreground">{row} × {cellHeight} = {viewportPx}px</span>
        </div>
      </div>
    );

    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <StickyNote className="h-4 w-4 shrink-0 text-yellow-400" />
          <span className="text-xs font-medium"><Trans>Bookmark</Trans></span>
          {infoButton}
        </div>
        {showCoords && coordsPanel}
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{bookmark.content}</p>
        <div className="border-t border-border pt-2">
          {confirmDelete ? (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground"><Trans>Are you sure?</Trans></span>
              <Button size="sm" variant="destructive" className="h-6 px-2 text-xs" onClick={() => void handleDelete(el)}>
                <Trans>Confirm</Trans>
              </Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setConfirmDelete(false)}>
                <Trans>Cancel</Trans>
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="destructive" className="h-6 px-2 text-xs" onClick={() => setConfirmDelete(true)}>
              <Trans>Delete</Trans>
            </Button>
          )}
        </div>
      </div>
    );
  };

  const renderCommentDetail = (el: AnnotationElement) => {
    const annotation = el.annotation!;
    const storedLine = annotation.data?.line as number | undefined;
    const ts = annotation.iso_timestamp;
    const sessionId = annotation.session_id;
    const coordsPanel = (
      <div className="rounded border border-border bg-muted/60 px-2 py-1.5 font-mono text-[10px] leading-relaxed">
        {ts && (
          <div className="mb-0.5 text-foreground">
            {fmtDate(ts)}
            <span className="ml-1.5 text-muted-foreground">({relTime(ts)})</span>
          </div>
        )}
        <div className="my-0.5 border-t border-border" />
        <div className="flex justify-between">
          <CoordLabel title="Absolute buffer row recorded at click time"><Trans>stored line</Trans></CoordLabel>
          <span className="text-foreground">{storedLine ?? el.absRow}</span>
        </div>
        <div className="flex justify-between">
          <CoordLabel title="Current resolved buffer row (may differ from stored line if terminal scrolled)"><Trans>live row</Trans></CoordLabel>
          <span className={storedLine !== undefined && storedLine !== el.absRow ? 'text-yellow-400' : 'text-foreground'}>{el.absRow}</span>
        </div>
        {sessionId && (
          <div className="flex justify-between gap-3">
            <CoordLabel title="Claude session ID this annotation is associated with"><Trans>session</Trans></CoordLabel>
            <span className="truncate max-w-[130px] text-foreground" title={sessionId}>{sessionId.slice(0, 8)}…</span>
          </div>
        )}
        {annotation.target_id && (
          <div className="flex justify-between gap-3">
            <CoordLabel title="ID of the entity this annotation targets (e.g. AgenticProcess)"><Trans>target</Trans></CoordLabel>
            <span className="truncate max-w-[130px] text-foreground" title={annotation.target_id}>{annotation.target_id.slice(0, 8)}…</span>
          </div>
        )}
      </div>
    );
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <MessageSquare className="h-4 w-4 shrink-0 text-sky-400" />
          <span className="text-xs font-medium"><Trans>Comment</Trans></span>
          <button
            type="button"
            className={cn('ml-auto flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-foreground', showCoords && 'text-foreground')}
            title={t`Show positioning info`}
            onClick={() => setShowCoords((v) => !v)}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </div>
        {showCoords && coordsPanel}
        {annotation.labels && annotation.labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {annotation.labels.map((l) => (
              <span key={l} className="rounded bg-sky-400/10 px-1 py-0.5 text-[9px] font-mono text-sky-500">{l}</span>
            ))}
          </div>
        )}
        {annotation.content && (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{annotation.content}</p>
        )}
      </div>
    );
  };

  const renderPromptDetail = (el: AnnotationElement) => {
    const annotation = el.annotation!;
    const ts = annotation.iso_timestamp;
    const sessionId = annotation.session_id;
    const coordsPanel = (
      <div className="rounded border border-border bg-muted/60 px-2 py-1.5 font-mono text-[10px] leading-relaxed">
        {ts && (
          <div className="mb-0.5 text-foreground">
            {fmtDate(ts)}
            <span className="ml-1.5 text-muted-foreground">({relTime(ts)})</span>
          </div>
        )}
        <div className="my-0.5 border-t border-border" />
        <div className="flex justify-between">
          <CoordLabel title="Current resolved buffer row — prompt annotations position by text-search in xterm buffer"><Trans>live row</Trans></CoordLabel>
          <span className="text-foreground">{el.absRow}</span>
        </div>
        {sessionId && (
          <div className="flex justify-between gap-3">
            <CoordLabel title="Claude session ID from the UserPromptSubmit hook event"><Trans>session</Trans></CoordLabel>
            <span className="truncate max-w-[130px] text-foreground" title={sessionId}>{sessionId.slice(0, 8)}…</span>
          </div>
        )}
        {annotation.target_id && (
          <div className="flex justify-between gap-3">
            <CoordLabel title="AgenticProcess ID this prompt annotation is linked to"><Trans>target</Trans></CoordLabel>
            <span className="truncate max-w-[130px] text-foreground" title={annotation.target_id}>{annotation.target_id.slice(0, 8)}…</span>
          </div>
        )}
      </div>
    );
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <Tag className="h-4 w-4 shrink-0 text-lime-400" />
          <span className="text-xs font-medium"><Trans>Prompt Annotation</Trans></span>
          <button
            type="button"
            className={cn('ml-auto flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-foreground', showCoords && 'text-foreground')}
            title={t`Show positioning info`}
            onClick={() => setShowCoords((v) => !v)}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </div>
        {showCoords && coordsPanel}
        {annotation.labels && annotation.labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {annotation.labels.map((l) => (
              <span key={l} className="rounded bg-lime-400/10 px-1 py-0.5 text-[9px] font-mono text-lime-500">{l}</span>
            ))}
          </div>
        )}
        {annotation.content && (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{annotation.content}</p>
        )}
      </div>
    );
  };

  const renderPlanDetail = (el: AnnotationElement) => {
    const annotation = el.annotation!;
    const filePath = (annotation.data as Record<string, unknown>)?.file_path as string | undefined;
    const ts = annotation.iso_timestamp;
    const sessionId = annotation.session_id;
    const coordsPanel = (
      <div className="rounded border border-border bg-muted/60 px-2 py-1.5 font-mono text-[10px] leading-relaxed">
        {ts && (
          <div className="mb-0.5 text-foreground">
            {fmtDate(ts)}
            <span className="ml-1.5 text-muted-foreground">({relTime(ts)})</span>
          </div>
        )}
        <div className="my-0.5 border-t border-border" />
        <div className="flex justify-between">
          <CoordLabel title="Current resolved buffer row — plan annotations position by text-search in xterm buffer"><Trans>live row</Trans></CoordLabel>
          <span className="text-foreground">{el.absRow}</span>
        </div>
        {sessionId && (
          <div className="flex justify-between gap-3">
            <CoordLabel title="Claude session ID from the ExitPlanMode hook event"><Trans>session</Trans></CoordLabel>
            <span className="truncate max-w-[130px] text-foreground" title={sessionId}>{sessionId.slice(0, 8)}…</span>
          </div>
        )}
        {filePath && (
          <div className="flex justify-between gap-3">
            <CoordLabel title="Full path to the plan .md file written by the agent"><Trans>plan file</Trans></CoordLabel>
            <span className="truncate max-w-[130px] text-foreground" title={filePath}>{filePath.split('/').pop()}</span>
          </div>
        )}
      </div>
    );
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <FileText className="h-4 w-4 shrink-0 text-blue-400" />
          <span className="text-xs font-medium"><Trans>Plan</Trans></span>
          <button
            type="button"
            className={cn('ml-auto flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-foreground', showCoords && 'text-foreground')}
            title={t`Show positioning info`}
            onClick={() => setShowCoords((v) => !v)}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </div>
        {showCoords && coordsPanel}
        {annotation.content && (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{annotation.content}</p>
        )}
        {filePath && (
          <button
            type="button"
            className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-blue-400 hover:bg-accent"
            onClick={() => {
              if (agenticProcessTypeId) {
                navigation.openPlan(agenticProcessTypeId, filePath);
              }
              setOpen(false);
            }}
          >
            <FileText className="h-3 w-3 shrink-0" />
            <span className="truncate">{filePath.split('/').pop()}</span>
          </button>
        )}
      </div>
    );
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <div
              className={cn(
                'group absolute flex cursor-pointer items-center justify-center',
                isEmpty && 'opacity-0 hover:opacity-100 hover:transition-none',
              )}
              style={{ top: row * cellHeight, left: 0, width: GUTTER_WIDTH, height: cellHeight }}
              onMouseEnter={() => onHoverRow?.(absoluteLine)}
              onMouseLeave={() => onHoverRow?.(null)}
            >
              {renderTriggerIcon()}
            </div>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="left" align="start" alignOffset={cellHeight} className="max-w-[260px] p-2">
          <AnnotationTooltipBody group={group} />
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="left" align="start" className="w-64 p-3">
        {renderPopoverContent()}
      </PopoverContent>
    </Popover>
  );
}
