import { Annotation, Bookmark, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import type { PtySyncSnapshot, PtySyncSession } from '@sdk/pty-sync/PtySyncSession.js';
import type { PtyAnchor } from '@sdk/pty-sync/PtySegment.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Extract prompt anchors from annotations for anchor-based PTY alignment. */
export function getAnchors(annotations: Annotation[]): PtyAnchor[] {
  return annotations
    .filter(a => a.labels?.includes('prompt:') && typeof a.content === 'string' && a.content && a.created_date)
    .map(a => ({ text: (a.content as string).trim().slice(0, 60), time: new Date(a.created_date as unknown as string).toISOString() }))
    .sort((a, b) => a.time.localeCompare(b.time));
}

export type AnnotationElementKind = 'bookmark' | 'comment' | 'prompt' | 'plan';

export interface AnnotationElement {
  kind: AnnotationElementKind;
  absRow: number;
  bookmark?: Bookmark;     // present when kind === 'bookmark'
  annotation?: Annotation; // present when kind === 'comment' | 'prompt' | 'plan'
}

function getAnnotationKind(annotation: Annotation): 'comment' | 'prompt' | 'plan' {
  if (annotation.labels?.includes('comment:')) return 'comment';
  if (annotation.labels?.includes('plan:')) return 'plan';
  return 'prompt';
}

/**
 * Scan the xterm buffer for a line containing searchText.
 * Returns the absolute buffer row, or null if not found.
 * Same approach as PtySyncSession.buildSegmentsFromAnchors().
 */
/**
 * Build search needles from annotation content.
 * Returns an array of candidate strings to search for (longest first).
 *
 * Plan annotations store markdown (e.g. "# Hello World Plan") but the terminal
 * renders the title without the `#` prefix ("Hello World Plan").  We try the
 * original first line AND a stripped variant so we match either representation.
 */
function buildNeedles(searchText: unknown): string[] {
  if (typeof searchText !== 'string') return [];
  const firstLine = searchText.trim().split('\n')[0].trim().slice(0, 60);
  if (!firstLine) return [];

  const needles = [firstLine];

  // Strip leading markdown heading markers: "# Title" → "Title"
  const stripped = firstLine.replace(/^#+\s*/, '');
  if (stripped && stripped !== firstLine) needles.push(stripped);

  return needles;
}

function findTextRow(adapter: NonNullable<PtySyncSnapshot['adapter']>, searchText: unknown, scanFrom = 0): number | null {
  const needles = buildNeedles(searchText);
  if (needles.length === 0) return null;
  const bufLen = adapter.getBufferLength();
  const eviction = adapter.getEvictionOffset();
  const startRow = Math.max(eviction, scanFrom);
  for (const needle of needles) {
    // Try with prompt prefix first (live session), fall back to raw text (replay).
    const candidates = ['❯ ' + needle, needle];
    for (let absRow = startRow; absRow < eviction + bufLen; absRow++) {
      const lineText = adapter.getLineText(absRow);
      if (lineText && candidates.some(c => lineText.trimStart().startsWith(c))) return absRow;
    }
  }
  return null;
}

/**
 * Bridges persisted Bookmark entities and Annotation entities → unified AnnotationElement[]
 * for the annotation gutter.
 *
 * Element kinds:
 *   - 'bookmark': Bookmark with bookmark_type === 'terminal_annotation' — positioned by data.line
 *   - 'comment': Annotation with labels.includes('comment:') — positioned by data.line
 *   - 'prompt': Annotation with labels.includes('prompt:') — positioned by text search in xterm buffer
 *   - 'plan': Annotation with labels.includes('plan:') — positioned by text search in xterm buffer
 *
 * Positioning strategy:
 *   - bookmark/comment: data.line (exact buffer row stored at user-click time)
 *   - prompt/plan: text search via adapter.getLineText() — runs after replayComplete so buffer is full
 */
export function useAnnotationGutter(
  workerSessionId: string | undefined | null,
  terminalReady: boolean,
  adapter: PtySyncSnapshot['adapter'],
  ptySyncSession: PtySyncSession,
  targetTimestamp?: string,
  replayComplete?: boolean,
  bufferVersion?: number,
  workdir?: string,
) {

  const queryRequest = useMemo(
    () => new QueryRequest({ type: 'bookmark', scope: [], name: 'useAnnotationGutter' }),
    [],
  );

  const { data: allBookmarks = [], refetch } = useEntitiesQuery<Bookmark>(queryRequest, {
    enabled: !!workerSessionId,
  });

  const annotationQueryRequest = useMemo(
    () => new QueryRequest({ type: 'annotation', scope: [], name: 'useAnnotationGutter_annotations' }),
    [],
  );

  const { data: allAnnotations = [], refetch: refetchAnnotations } = useEntitiesQuery<Annotation>(
    annotationQueryRequest,
    { enabled: !!workerSessionId }
  );

  const sessionBookmarks = useMemo(
    () =>
      workerSessionId
        ? allBookmarks.filter(
            (m) => m.bookmark_type === 'terminal_annotation' && m.session_id === workerSessionId,
          )
        : [],
    [allBookmarks, workerSessionId],
  );

  const sessionAnnotations = useMemo(
    () => workerSessionId
      ? allAnnotations.filter(a => a.session_id === workerSessionId)
      : [],
    [allAnnotations, workerSessionId],
  );

  // Scroll-to-annotation state
  const scrollFiredRef = useRef(false);
  const [pendingScrollLine, setPendingScrollLine] = useState<number | null>(null);

  // Build unified elements array from bookmarks + annotations.
  // Prompt/plan annotations use text search — only run after replayComplete so the buffer is populated.
  const elements: AnnotationElement[] = useMemo(() => {
    if (!adapter || !terminalReady || !replayComplete || !workerSessionId) return [];
    const result: AnnotationElement[] = [];

    // Bookmarks: positioned by data.line (stored at user-click time)
    for (const bookmark of sessionBookmarks) {
      if (!bookmark.id) continue;
      const absRow = bookmark.data?.line as number | undefined;
      if (absRow === undefined) continue;
      result.push({ kind: 'bookmark', absRow, bookmark });
    }

    // Annotations: comments use data.line; prompt/plan use text search.
    // Sort by created_date so scanFrom advances correctly for duplicate text.
    const sortedAnnotations = [...sessionAnnotations].sort((a, b) =>
      String(a.created_date ?? '').localeCompare(String(b.created_date ?? '')),
    );
    let scanFrom = 0;
    for (const annotation of sortedAnnotations) {
      if (!annotation.id) continue;
      const kind = getAnnotationKind(annotation);

      let absRow: number | null = null;
      if (kind === 'plan' && ptySyncSession) {
        const timestamp = new Date(annotation.iso_timestamp!).getTime();
        absRow = ptySyncSession.bucketTimestamp(timestamp);
        if (absRow === null) continue;
      } else if (kind === 'comment') {
        const line = annotation.data?.line as number | undefined;
        if (line === undefined) continue;
        absRow = line;
      } else {
        // prompt or plan: find exact buffer row by scanning for content text
        const content = annotation.content as string | undefined;
        if (!content) continue;
        absRow = findTextRow(adapter, content, scanFrom);
        if (absRow === null) continue;
        scanFrom = absRow + 1;
      }

      result.push({ kind, absRow, annotation });
    }

    return result;
  }, [adapter, terminalReady, replayComplete, workerSessionId, sessionBookmarks, sessionAnnotations, ptySyncSession, bufferVersion]);

  // Reset scroll state on session or timestamp change
  useEffect(() => {
    scrollFiredRef.current = false;
    setPendingScrollLine(null);
  }, [workerSessionId, targetTimestamp]);

  // Resolve target scroll line once replay is complete
  useEffect(() => {
    if (!replayComplete || !targetTimestamp || scrollFiredRef.current) return;
    if (!adapter || !terminalReady) return;

    const targetBookmark = sessionBookmarks.find((m) => m.created_date === targetTimestamp);
    if (!targetBookmark) return;

    const absRow = targetBookmark.data?.line as number | undefined;
    if (absRow === undefined) return;

    scrollFiredRef.current = true;
    setPendingScrollLine(absRow);
  }, [replayComplete, targetTimestamp, sessionBookmarks, adapter, terminalReady]);

  const createBookmark = useCallback(
    async (absoluteLine: number, content: string) => {
      if (!workerSessionId) return;
      const bookmark = new Bookmark({
        bookmark_type: 'terminal_annotation',
        session_id: workerSessionId,
        work_dir: workdir,
        data: { line: absoluteLine },
        content,
        title: 'Bookmark',
        status: 'open',
      });
      await bookmark.save([]);
      await refetch();
    },
    [workerSessionId, workdir, refetch],
  );

  const createComment = useCallback(
    async (absoluteLine: number, content: string) => {
      if (!workerSessionId) return;
      const annotation = new Annotation({
        labels: ['comment:'],
        session_id: workerSessionId,
        data: { line: absoluteLine },
        content,
        iso_timestamp: new Date().toISOString(),
      });
      await annotation.save([]);
      await refetchAnnotations();
    },
    [workerSessionId, refetchAnnotations],
  );

  const deleteBookmark = useCallback(
    async (element: AnnotationElement) => {
      if (element.bookmark) {
        await element.bookmark.delete();
        await refetch();
      }
    },
    [refetch],
  );

  const deleteBookmarkByBookmark = useCallback(
    async (bookmark: Bookmark) => {
      await bookmark.delete();
      await refetch();
    },
    [refetch],
  );

  return { elements, createBookmark, createComment, deleteBookmark, deleteBookmarkByBookmark, pendingScrollLine, sessionAnnotations };
}
