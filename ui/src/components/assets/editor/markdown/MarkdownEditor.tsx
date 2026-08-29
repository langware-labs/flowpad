import type { Editor as MilkdownEditorInstance } from '@milkdown/core';
import { EditorWithSidePanel, type ExtraSideTab } from '@src/components/milkdown-editor/EditorWithSidePanel';
import { MilkdownEditor } from '@src/components/milkdown-editor/MilkdownEditor';
import { ReviewSurface } from '@src/components/assets/editor/markdown/ReviewSurface';
import { Button } from '@src/components/ui/button';
import { WikiToolbar } from '@src/components/wiki-toolbar';
import { useMarkdownContent } from '@src/hooks/use-markdown-content';
import { useAssetRevisionStatus } from '@src/hooks/use-asset-revision-status';
import { AssetGitPill } from './AssetGitPill';
import { RevisionsPanel } from '@src/components/assets/editor/revisions/RevisionsPanel';
import { History } from 'lucide-react';
import { DockPointer, HIGHLIGHT_PARAM } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useSideWindows } from '@src/navigation/useSideWindows';
import { FSRef, PageId, TypeId, PrefKey, copyToClipboard, dataManager, looksBinaryText } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import { downloadFile } from '@sdk/utils/utils';
import Editor, { type OnMount } from '@monaco-editor/react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Eye,
  ExternalLink,
  FileCode,
  FilePlus2,
  GraduationCap,
  MessageSquareDiff,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { useIsAdvanced } from '@src/components/view-mode';
import { ShareButton } from '@src/components/entity-actions/ShareButton';
import { ShareToConversationDialog } from '@src/components/share-to-conversation/ShareToConversationDialog';
import { genericEntityShareSource } from '@src/hooks/share-sources';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { AssetCollisionBadge, useAssetCollisionSideTab } from '../AssetCollisionUI';

export const EDITOR_MODES = ['view', 'review', 'editor', 'markdown', 'learning'] as const;
export type EditorMode = (typeof EDITOR_MODES)[number];
// Backwards-compatible internal alias; new code should use `EditorMode`.
type ViewMode = EditorMode;

const EDITOR_MODE_PARAM = 'editorMode';
// Optional 1-indexed body line to drop the caret on at first mount (e.g. a
// freshly-created skill opens with the caret right after its `# <name>`
// headline). Once the user moves the caret, that live position takes over.
const INITIAL_LINE_PARAM = 'initialLine';
const DEFAULT_MODE: ViewMode = 'view';

function isEditorMode(value: string | undefined | null): value is ViewMode {
  return value != null && (EDITOR_MODES as readonly string[]).includes(value);
}

/** 'review' and 'markdown' are power-user surfaces — only shown in Advanced. */
function isAdvancedOnlyMode(mode: ViewMode): boolean {
  return mode === 'review' || mode === 'markdown';
}

const MODE_ICONS: Record<ViewMode, React.ComponentType<{ className?: string }>> = {
  view: Eye,
  review: MessageSquareDiff,
  editor: Pencil,
  markdown: FileCode,
  learning: GraduationCap,
};

/**
 * Context handed to `headerExtras` — the live frontmatter buffer of the editor.
 * A header control (e.g. the skill eval toggle) reads `fields` and writes via
 * `setField`, going through the SAME content buffer as the body autosave, so
 * there is a single writer to the file (no two-writer race).
 */
export interface MarkdownHeaderExtrasCtx {
  fields: Record<string, string>;
  setField: (key: string, value: string) => void;
}

export interface WikiLinkTarget {
  page: PageId;
  space: string;
}

interface MarkdownEditorProps {
  /** FSRef to the .md file — carries path + typeId + read/write. */
  fsRef: FSRef;
  /** Existing entity whose durable content is edited by this surface. */
  editEntity?: { markEdit(): void } | null;
  /**
   * Serialized TypeId of the entity this markdown belongs to (e.g. `"plan-<id>"`).
   * Keys Editor + Backlinks tabs. Null disables editor persistence on this file.
   */
  chatTarget: string | null;
  /**
   * Frontmatter-aware header slot. Rendered in the header (live state only) with
   * the editor's own `fields`/`setField`, so a control can read+write a
   * frontmatter key through the single content buffer.
   */
  headerExtras?: (ctx: MarkdownHeaderExtrasCtx) => React.ReactNode;
  /** Appended to the side drawer after Backlinks. */
  extraSideTabs?: ExtraSideTab[];
  /** When true, the "Learning" view-mode chip appears in the header strip. */
  showLearningMode?: boolean;
  /** Body rendered when viewMode === 'learning'. Required when showLearningMode is true. */
  learningPanel?: React.ReactNode;
  /**
   * When provided, the editor header renders a Delete button that opens a
   * confirmation dialog and calls this on confirm. Callers own the actual
   * delete and any post-delete navigation. Omit to hide the button (e.g.
   * for read-only or entity-less files).
   */
  onDelete?: () => Promise<void>;
  /** Display name shown in the delete confirmation. Defaults to the filename. */
  deleteLabel?: string;
  /**
   * External change token (typically the backing entity's `updated_date`). When
   * it changes, the body is re-read from disk — closes the
   * `file change → reindex → updated_date → refresh` loop so an out-of-band edit
   * (e.g. an agent editing this open doc) refreshes the view. Ignored while the
   * buffer is dirty (unsaved edits win).
   */
  reloadKey?: string | number;
  /**
   * Optional heading slug (a GFM slug like "auto-run"). When set, the body
   * scrolls to that heading once it renders — the deep-link target for wiki
   * fragment URLs (`…/wiki/<name>` + `?wikiFragment=<slug>`).
   */
  fragment?: string;
  /**
   * Override the missing-file copy (note + action-button label) — e.g. the
   * task Plan section shows "This task has no spec yet." / "Add spec" instead
   * of the generic "Note: File is missing / Re-create it". The editor keeps
   * ownership of the layout, button, and `recreate` wiring; custom copy also
   * drops the raw source-path line (a missing file is a normal state for
   * such surfaces, not an error worth a path dump).
   */
  missingFileCopy?: { note: React.ReactNode; actionLabel: React.ReactNode };
  /**
   * Chrome variant. `'full'` (default) is the complete editor: header with
   * mode controls/Properties/Copy + the side rail. Asset identity and path live
   * in AssetsPage's primary header. `'plain'` is a
   * stripped read-only "plain doc": just the body under a minimal header of
   * `plainLeadingActions` + Share + `plainTrailingActions` — no path, Properties,
   * Copy, mode toggle, or side rail. Used by the wiki modal.
   */
  variant?: 'full' | 'plain';
  /**
   * Plain header (`variant='plain'`): composes the action row. Receives the
   * editor's ready-made Share button so the caller decides where Share sits
   * (e.g. `(share) => <>{open}{share}{switcher}</>`).
   */
  plainHeaderActions?: (share: React.ReactNode) => React.ReactNode;
  /** Wiki links in this document stay on this URL authority/namespace. */
  wikiLinkTarget?: WikiLinkTarget;
}

/**
 * Generic markdown editor.
 *
 * - The compact document row starts with mode selection; edit tools expand inline.
 * - Shows a Properties block only when the file has YAML frontmatter.
 * - Fields are rendered dynamically from whatever keys exist in the frontmatter.
 * - Body is rendered by Milkdown (view/review/editor) or Monaco (markdown).
 * - The chosen mode is persisted across docs via the EDITOR_MODE preference.
 * - `variant='plain'` collapses all of that to a read-only body + a 3-item header.
 */
export function MarkdownEditor({
  fsRef,
  editEntity,
  chatTarget,
  headerExtras,
  extraSideTabs,
  showLearningMode,
  learningPanel,
  onDelete,
  deleteLabel,
  reloadKey,
  fragment,
  missingFileCopy,
  variant,
  plainHeaderActions,
  wikiLinkTarget,
}: MarkdownEditorProps) {
  return (
    <MarkdownEditorContent
      fsRef={fsRef}
      sourcePath={fsRef.path}
      editEntity={editEntity}
      chatTarget={chatTarget}
      headerExtras={headerExtras}
      extraSideTabs={extraSideTabs}
      showLearningMode={showLearningMode}
      learningPanel={learningPanel}
      onDelete={onDelete}
      deleteLabel={deleteLabel}
      reloadKey={reloadKey}
      fragment={fragment}
      missingFileCopy={missingFileCopy}
      variant={variant}
      plainHeaderActions={plainHeaderActions}
      wikiLinkTarget={wikiLinkTarget}
    />
  );
}

// ── In-doc anchor links ───────────────────────────────────────────────────────
// Milkdown's heading-id slugifier disagrees with the GFM slugs hand-authored
// TOCs use (it keeps `.`, `/`, en-dashes), so getElementById usually misses.
// We resolve the click against the rendered headings without touching the doc.

function isSlugLink(href: string): string | null {
  return href.startsWith('#') ? decodeURIComponent(href.slice(1)).toLowerCase() : null;
}

function gfmSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// Whitelist a frontmatter `direction` value to the two recognized base
// directions. Anything else (missing, empty, typo) → undefined, which omits
// the `dir` attribute on the editor wrapper and keeps default LTR behavior.
function normalizeDirection(value: string | undefined): 'ltr' | 'rtl' | undefined {
  const v = value?.trim().toLowerCase();
  return v === 'ltr' || v === 'rtl' ? v : undefined;
}

/** Resolve the rendered heading matching `slug` (Milkdown's own ids first, then
 *  a GFM-slug scan of the rendered headings), or null if not present yet. */
function findHeading(slug: string): HTMLElement | null {
  return (
    document.getElementById(slug) ??
    Array.from(document.querySelectorAll<HTMLElement>('.ProseMirror :is(h1,h2,h3,h4,h5,h6)')).find(
      (h) => gfmSlug(h.textContent ?? '') === slug,
    ) ??
    null
  );
}

/** Scroll to the heading matching `slug`, if present. */
function goToSlug(slug: string, smooth = true): void {
  findHeading(slug)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
}

// ── Editor content ────────────────────────────────────────────────────────────

function MarkdownEditorContent({
  fsRef,
  sourcePath,
  editEntity,
  chatTarget,
  headerExtras,
  extraSideTabs,
  showLearningMode,
  learningPanel,
  onDelete,
  deleteLabel,
  reloadKey,
  fragment,
  missingFileCopy,
  variant,
  plainHeaderActions,
  wikiLinkTarget,
}: {
  fsRef: FSRef;
  sourcePath: string;
  editEntity?: MarkdownEditorProps['editEntity'];
  chatTarget: string | null;
  headerExtras?: MarkdownEditorProps['headerExtras'];
  extraSideTabs?: ExtraSideTab[];
  showLearningMode?: boolean;
  learningPanel?: React.ReactNode;
  onDelete?: MarkdownEditorProps['onDelete'];
  deleteLabel?: MarkdownEditorProps['deleteLabel'];
  reloadKey?: string | number;
  fragment?: string;
  missingFileCopy?: MarkdownEditorProps['missingFileCopy'];
  variant?: MarkdownEditorProps['variant'];
  plainHeaderActions?: MarkdownEditorProps['plainHeaderActions'];
  wikiLinkTarget?: MarkdownEditorProps['wikiLinkTarget'];
}) {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();

  // Standard vs Advanced (Advanced || Dev) skin gating. Standard hides the
  // power-user affordances (eval/worker buttons, the secondary file toolbar,
  // the project chip, the review/markdown editor modes, the side window).
  const advanced = useIsAdvanced();

  // viewMode source of truth: URL `?editorMode=…` if present and valid; else
  // last-used value from the stored preference; else DEFAULT_MODE. Updating
  // viewMode pushes a new DockPointer with the option merged in — the URL
  // becomes shareable + back-button-restorable, and per-tab independent.
  const urlMode = currentDock?.options?.[EDITOR_MODE_PARAM];
  const [storedMode, setStoredMode] = usePreference<EditorMode>(PrefKey.EDITOR_MODE);
  const rawViewMode: ViewMode = isEditorMode(urlMode) ? urlMode : isEditorMode(storedMode) ? storedMode : DEFAULT_MODE;
  // In Standard, fall back to 'view' so the body never renders a surface whose
  // chip is hidden (e.g. a share-link pinning ?editorMode=review opened by a
  // Standard user).
  const viewMode: ViewMode = !advanced && isAdvancedOnlyMode(rawViewMode) ? 'view' : rawViewMode;

  const setViewMode = useCallback(
    (mode: ViewMode) => {
      if (!currentDock) return; // outside dock context — shouldn't happen for MarkdownEditor
      if (mode === viewMode) return; // active chips are idempotent; preserve child editor state
      navigation.openDock(currentDock.withOption(EDITOR_MODE_PARAM, mode));
    },
    [currentDock, navigation, viewMode],
  );

  // Restore from a stale 'learning' selection when the chip is hidden for this doc.
  // For URL-bound state, that means stripping ?editorMode=learning so the URL
  // reflects the actual visible mode (silent + clean per design).
  //
  // Guard against the initial-mount race: `showLearningMode` is computed by
  // the host editor from an async process query, so it starts `false` for
  // ~one tick even when this doc DOES have learning runs. Stripping then would
  // wipe a legitimate `?editorMode=learning` share-link. We delay the strip
  // by a small idle period; if learning becomes available within that window,
  // the timer is cancelled and the URL is preserved.
  useEffect(() => {
    if (urlMode !== 'learning' || showLearningMode || !currentDock) return;
    const handle = window.setTimeout(() => {
      navigation.openDock(currentDock.withOption(EDITOR_MODE_PARAM, null));
    }, 1500);
    return () => window.clearTimeout(handle);
  }, [urlMode, showLearningMode, currentDock, navigation]);

  // Imperative handle to the underlying Milkdown editor — driven by the
  // wiki toolbar to insert wikilinks at the cursor.
  const milkdownRef = useRef<MilkdownEditorInstance | null>(null);

  // For an `owns_main_ref` type (e.g. prompt) the ENTITY is authoritative over
  // the file, so a save that only lands on disk gets reverted by the next
  // `entity.save()` re-render. Those saves reindex back into the entity; the
  // hand-edited types (markdown, skill) are already file-authoritative and skip
  // the cost. Registry-driven off the entity's own type — never a type allowlist.
  const reindexOnSave = useMemo(() => {
    if (!chatTarget) return false;
    try {
      const typeName = new TypeId(chatTarget).type;
      return !!dataManager.getAllTypeInfos?.().find((t) => t.type_name === typeName)?.owns_main_ref;
    } catch {
      return false; // not a parseable TypeId (raw file) → no entity to reindex into
    }
  }, [chatTarget]);

  // Keep the stored preference as the no-URL fallback for new docs / fresh links.
  useEffect(() => {
    setStoredMode(viewMode);
  }, [viewMode, setStoredMode]);

  const {
    fields,
    hasFields,
    body,
    bodyStartLine,
    setField,
    setBody,
    dirty,
    isLoading,
    loadError,
    isMissing,
    recreate,
    reload,
    lastSync,
  } = useMarkdownContent(fsRef, { autoSave: true, autoSaveMs: 2000, reloadKey, reindexOnSave });
  const markEntityEdited = useCallback(() => editEntity?.markEdit(), [editEntity]);
  const setEditedField = useCallback((key: string, value: string) => {
    setField(key, value);
    markEntityEdited();
  }, [markEntityEdited, setField]);

  const [propsExpanded, setPropsExpanded] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [editorToolbarTarget, setEditorToolbarTarget] = useState<HTMLDivElement | null>(null);

  // ── Per-asset git revisions (common to every asset editor) ──────────────────
  // Self-contained from the file's own ref so history resolves against the file's
  // OWN repo regardless of which project is active: run git from the file's
  // directory (git walks up to the enclosing .git) with the bare filename as the
  // pathspec. `lastSync` (set on every autosave) re-fetches after the backend
  // auto-commits the file.
  // The plain document surface has no revision UI. Full editors retain their
  // normal chrome for every authority, while Git/OS actions are enabled only
  // when the ref is actually backed by a local compute node.
  const gitComputeNodeId = fsRef.localComputeNodeId;
  const revisionsEnabled = variant !== 'plain' && gitComputeNodeId !== null;
  const gitFileDir = fsRef.parent.path;
  const gitFileName = fsRef.path.slice(fsRef.path.lastIndexOf('/') + 1);
  const revisionStatus = useAssetRevisionStatus(
    revisionsEnabled ? gitComputeNodeId : null,
    gitFileDir,
    gitFileName,
    lastSync,
  );

  // Side windows are URL-first dock state (see useSideWindows). The header git
  // pill opens the "revisions" window by navigating, not by lifting local state.
  const { open: openSideWindow } = useSideWindows();

  const revisionsTab = useMemo<ExtraSideTab>(
    () => ({
      id: 'revisions',
      label: revisionStatus.version != null ? t`Revisions v${revisionStatus.version}` : t`Revisions`,
      icon: History,
      description: t`Revision history of this file`,
      panel: (
        <RevisionsPanel
          computeNodeId={gitComputeNodeId}
          workdir={gitFileDir}
          file={gitFileName}
          revisions={revisionStatus.revisions}
          hasRepo={revisionStatus.hasRepo}
          refresh={revisionStatus.refresh}
          onRestored={reload}
        />
      ),
    }),
    [t, revisionStatus, gitComputeNodeId, gitFileDir, gitFileName, reload],
  );

  const collisionTab = useAssetCollisionSideTab();

  const allSideTabs = useMemo(
    () => [
      ...(revisionsEnabled ? [revisionsTab] : []),
      ...(collisionTab ? [collisionTab] : []),
      ...(extraSideTabs ?? []),
    ],
    [revisionsEnabled, revisionsTab, collisionTab, extraSideTabs],
  );

  const shareSource = useMemo(() => {
    if (!chatTarget) return null;
    const label = (typeof sourcePath === 'string' ? sourcePath.split('/').pop() : null) || undefined;
    return genericEntityShareSource(new TypeId(chatTarget), { label });
  }, [chatTarget, sourcePath]);

  // On-disk caret line shared across all editor backends. Null means "user has
  // not clicked yet". Only read when an editor (re)mounts on a mode switch, so
  // caret restores to the same logical position — a ref, not state, so caret
  // moves don't re-render the editor tree.
  const cursorLineRef = useRef<number | null>(null);
  const bodyStartLineRef = useRef(bodyStartLine);
  bodyStartLineRef.current = bodyStartLine;
  const handleEditorLineChange = useCallback((bodyLine: number) => {
    cursorLineRef.current = bodyStartLineRef.current + bodyLine - 1;
  }, []);
  // Seed the caret from `?initialLine=N` on a fresh open (no user caret yet) —
  // body-line space, so it survives frontmatter changes. Cleared once the user
  // clicks/types and `cursorLineRef` becomes the source of truth.
  const initialLineParam = useMemo(() => {
    const raw = currentDock?.options?.[INITIAL_LINE_PARAM];
    if (raw == null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [currentDock?.options]);
  const initialBodyLine = cursorLineRef.current != null ? cursorLineRef.current - bodyStartLine + 1 : initialLineParam;

  const setBodyRef = useRef(setBody);
  setBodyRef.current = setBody;
  const handleBodyChange = useCallback((newBody: string) => {
    setBodyRef.current(newBody);
  }, []);

  const sourcePathStr = typeof sourcePath === 'string' ? sourcePath : '';
  const fileName = sourcePathStr.split('/').pop() || sourcePathStr;
  const handleOpenExternal = useMemo(
    () =>
      fsRef.localComputeNodeId
        ? () => {
            void fsRef.open({ select: true });
          }
        : undefined,
    [fsRef],
  );

  const handleDownload = useCallback(() => {
    void (async () => {
      const content = await fsRef.read();
      downloadFile({ name: fileName, content: new Blob([content], { type: 'text/markdown' }) });
    })();
  }, [fsRef, fileName]);

  const handleDelete = useMemo(() => {
    if (!onDelete) return undefined;
    return () => {
      showDeleteAssetModal({
        name: deleteLabel ?? fileName,
        onConfirm: onDelete,
      });
    };
  }, [onDelete, deleteLabel, fileName]);

  // Plain WikiTips keep the same compact, read-only header through every
  // content state. Dock Wiki pages use the full editor header for both local
  // and Hub authorities.
  const shareButton = shareSource ? (
    <ShareButton
      onClick={() => setShareOpen(true)}
      tooltip={t`Share to a conversation`}
      testId="markdown-editor-share"
    />
  ) : null;
  const shareDialog =
    shareSource && shareOpen ? (
      <ShareToConversationDialog open={shareOpen} onClose={() => setShareOpen(false)} source={shareSource} />
    ) : null;
  const transientHeader =
    variant === 'plain' ? (
      <PlainDocumentHeader>{plainHeaderActions?.(shareButton)}</PlainDocumentHeader>
    ) : (
      <EditorHeader
        dirty={false}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onOpenExternal={handleOpenExternal}
        onDownload={handleDownload}
        onDelete={handleDelete}
        showLearningMode={showLearningMode}
      />
    );

  const handleLinkClick = useCallback(
    (href: string) => {
      // WikiTip backward link: `/?highlight=<wikiword>` routes home and highlights
      // the matching feed entry. URL-carried so it is shareable + back-safe — see
      // docs/wikitip.md. Checked first since it isn't a slug/wiki/asset href.
      const highlight = new URL(href, window.location.origin).searchParams.get(HIGHLIGHT_PARAM);
      if (highlight) {
        navigation.highlight(highlight);
        return;
      }

      const slug = isSlugLink(href);
      if (slug !== null) {
        goToSlug(slug);
        return;
      }

      // /dock/assets/wiki/<name>[#<frag>] → keep the URL at the wiki form; the
      // wiki route view (WikiResolveView) does the name resolution. A trailing
      // `#<frag>` deep-links to a heading (rides as a query param, not the path).
      const wikiMatch = href.match(/\/dock\/assets\/wiki\/([^?#]+)(?:#([^?\s]+))?/);
      if (wikiMatch) {
        const name = decodeURIComponent(wikiMatch[1]).replace(/\.md$/i, '');
        const frag = wikiMatch[2] ? decodeURIComponent(wikiMatch[2]) : undefined;
        const pointer = DockPointer.forWiki(name, undefined, wikiLinkTarget?.space, frag);
        navigation.openDock(wikiLinkTarget ? pointer.withPage(wikiLinkTarget.page) : pointer);
        return;
      }

      const dir = sourcePathStr.slice(0, sourcePathStr.lastIndexOf('/'));
      const resolvedPath = href.startsWith('/') ? href : `${dir}/${href}`;
      const assetType = currentDock?.pointer?.split('/')?.[1] ?? 'claude_memory';
      navigation.openDock(DockPointer.forAssetEditor(assetType, resolvedPath));
    },
    [sourcePathStr, currentDock, navigation, wikiLinkTarget],
  );

  // Deep-link scroll: when opened with a `fragment` (wiki anchor), scroll to the
  // matching heading once, after the body paints. Milkdown renders headings — and
  // keeps growing the document — a few frames after content loads, so scrolling
  // once on first sight lands short; we cache the heading and re-correct across
  // frames until its position holds steady (bounded). Gated per-fragment (a ref,
  // and no `body` dependency) so typing in the body never re-yanks the viewport
  // back to the anchor.
  const scrolledFragmentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!fragment || isLoading || isMissing) return;
    if (scrolledFragmentRef.current === fragment) return;
    const slug = fragment.toLowerCase();
    let raf = 0;
    let framesLeft = 60;
    let stable = 0;
    let lastTop = Number.NaN;
    let heading: HTMLElement | null = null;
    const attempt = () => {
      heading ??= findHeading(slug); // scan the DOM only until the heading exists
      if (heading) {
        heading.scrollIntoView({ block: 'start' });
        const top = Math.round(heading.getBoundingClientRect().top);
        if (top === lastTop) {
          if (++stable >= 2) {
            scrolledFragmentRef.current = fragment; // settled — don't re-scroll on edits
            return;
          }
        } else {
          stable = 0;
          lastTop = top;
        }
      }
      if (framesLeft-- > 0) raf = requestAnimationFrame(attempt);
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  }, [fragment, isLoading, isMissing]);

  // ── Loading ────────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        {transientHeader}
        {shareDialog}
        <div className="flex flex-1 items-center justify-center">
          <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  // ── Missing file ──────────────────────────────────────────────────────────
  if (isMissing) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        {transientHeader}
        {shareDialog}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="text-sm font-medium text-foreground">
            {missingFileCopy?.note ?? <Trans>Note: File is missing</Trans>}
          </p>
          {!missingFileCopy && <p className="break-all font-mono text-xs text-muted-foreground">{sourcePathStr}</p>}
          <Button variant="outline" size="sm" onClick={() => void recreate()}>
            <FilePlus2 className="mr-1 h-4 w-4" />
            {missingFileCopy?.actionLabel ?? <Trans>Re-create it</Trans>}
          </Button>
        </div>
      </div>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        {transientHeader}
        {shareDialog}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="text-sm text-muted-foreground">{loadError.message}</p>
          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCw className="mr-1 h-4 w-4" />
            <Trans>Retry</Trans>
          </Button>
        </div>
      </div>
    );
  }

  // ── Binary / non-text body ──────────────────────────────────────────────────
  // Never hand binary content to Milkdown/Monaco — it locks up the renderer and
  // can hang the whole app (e.g. an image mistakenly stored as a .md body). Show
  // a safe placeholder with a download escape hatch instead.
  if (looksBinaryText(body)) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        {transientHeader}
        {shareDialog}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="text-sm font-medium text-foreground">
            <Trans>This file isn't text</Trans>
          </p>
          <p className="max-w-md text-xs text-muted-foreground">
            <Trans>
              Its contents look like binary data (for example an image), so it can't be shown in the editor.
            </Trans>
          </p>
          <p className="break-all font-mono text-xs text-muted-foreground">{sourcePathStr}</p>
          <Button variant="outline" size="sm" onClick={handleDownload}>
            <Download className="mr-1 h-4 w-4" />
            <Trans>Download</Trans>
          </Button>
        </div>
      </div>
    );
  }

  // Body renderer — the single Milkdown invocation both paths share, so a
  // body-mount change (a new prop, plugin, direction/fragment tweak) can't drift
  // between the plain doc and the full editor.
  const milkdownBody = (mode: ViewMode) => (
    <MilkdownEditor
      content={body}
      onChange={handleBodyChange}
      onUserEdit={markEntityEdited}
      onLinkClick={handleLinkClick}
      editorMode={mode === 'learning' ? 'view' : mode}
      editorRef={milkdownRef}
      onCursorLineChange={handleEditorLineChange}
      initialLine={initialBodyLine}
      direction={normalizeDirection(fields.direction)}
      toolbarPortalTarget={mode === 'editor' ? editorToolbarTarget : undefined}
      toolbarRight={
        mode === 'editor' ? (
          <WikiToolbar editorRef={milkdownRef} sourceTypeId={chatTarget} onUserEdit={markEntityEdited} />
        ) : undefined
      }
    />
  );

  // ── Plain doc ────────────────────────────────────────────────────────────
  // Read-only body under a minimal header. The caller composes the whole action
  // row via `plainHeaderActions(share)` — it receives the ready-made Share node
  // and decides where Share sits. No path, Properties, Copy, mode toggle, or
  // side rail. Used by the wiki modal.
  if (variant === 'plain') {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <PlainDocumentHeader>{plainHeaderActions?.(shareButton)}</PlainDocumentHeader>
        {shareDialog}
        <div className="min-h-0 flex-1 overflow-hidden">{milkdownBody('view')}</div>
      </div>
    );
  }

  // ── Editor ─────────────────────────────────────────────────────────────────
  const leadingActions = revisionsEnabled ? (
    <AssetGitPill
      version={revisionStatus.version}
      unpushed={revisionStatus.unpushed}
      hasRepo={revisionStatus.hasRepo}
      computeNodeId={gitComputeNodeId}
      workdir={gitFileDir}
      onOpenHistory={() => openSideWindow('revisions')}
      onAfterPublish={revisionStatus.refresh}
    />
  ) : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <EditorHeader
        dirty={dirty}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onOpenExternal={handleOpenExternal}
        onDownload={handleDownload}
        onDelete={handleDelete}
        leadingActions={leadingActions}
        modeActions={viewMode === 'view' ? <CopyContentButton body={body} /> : null}
        editorToolbarHostRef={setEditorToolbarTarget}
        nameExtras={headerExtras?.({ fields, setField: setEditedField })}
        showLearningMode={showLearningMode}
      />

      {hasFields && (
        <div className="flex-shrink-0 border-b">
          <button
            className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setPropsExpanded((e) => !e)}
          >
            {propsExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Trans>Properties</Trans>
          </button>

          {propsExpanded && (
            <div className="flex flex-col gap-2 px-3 pb-3">
              {Object.entries(fields).map(([key, value]) => (
                <div key={key} className="flex flex-col gap-1">
                  <label className="text-xs capitalize text-muted-foreground">{key}</label>
                  <input
                    className="rounded-md border bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring"
                    value={value}
                    onChange={(e) => {
                      setField(key, e.target.value);
                      if (e.nativeEvent.isTrusted) markEntityEdited();
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {viewMode === 'learning' && learningPanel ? (
          <div className="h-full overflow-hidden">{learningPanel}</div>
        ) : (
          <EditorWithSidePanel target={chatTarget} extraTabs={allSideTabs}>
            {viewMode === 'markdown' ? (
              <MonacoMarkdownEditor
                value={body}
                onChange={handleBodyChange}
                onUserEdit={markEntityEdited}
                onCursorLineChange={handleEditorLineChange}
                initialLine={initialBodyLine}
              />
            ) : viewMode === 'review' ? (
              <ReviewSurface body={body} docTypeId={chatTarget} />
            ) : (
              milkdownBody(viewMode)
            )}
          </EditorWithSidePanel>
        )}
      </div>
    </div>
  );
}

function PlainDocumentHeader({ children }: { children?: React.ReactNode }) {
  return (
    <div
      className="flex flex-shrink-0 items-center justify-end gap-1 border-b px-3 py-2"
      data-testid="plain-markdown-header"
    >
      {children}
    </div>
  );
}

// Read-only document action rendered inside the view/edit mode group.
function CopyContentButton({ body }: { body: string }) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    await copyToClipboard(body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [body]);

  return (
    <button
      type="button"
      className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      onClick={() => void handleCopy()}
      title={t`Copy content to clipboard`}
      data-testid="markdown-editor-copy-content"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
    </button>
  );
}

// ── Monaco markdown editor ────────────────────────────────────────────────────

function MonacoMarkdownEditor({
  value,
  onChange,
  onUserEdit,
  onCursorLineChange,
  initialLine,
}: {
  value: string;
  onChange: (v: string) => void;
  onUserEdit?: () => void;
  onCursorLineChange?: (bodyLine: number) => void;
  initialLine?: number | null;
}) {
  const { resolvedTheme } = useTheme();
  // Capture initialLine at mount via a ref so handleMount can read the latest
  // value supplied at first render without re-mounting on prop changes.
  const initialLineRef = useRef(initialLine ?? null);
  const onCursorLineChangeRef = useRef(onCursorLineChange);
  onCursorLineChangeRef.current = onCursorLineChange;

  const handleMount = useCallback<OnMount>((editor) => {
    // Mark "user has interacted" only when restoring from a known line OR when
    // the user actually clicks/types. Initial-mount cursor at line 1 with no
    // restoration must not emit (matches Q3: no badge until first interaction).
    let userInteracted = false;
    const target = initialLineRef.current;
    if (target != null && target > 0) {
      editor.setPosition({ lineNumber: target, column: 1 });
      editor.revealLineInCenter(target);
      userInteracted = true;
    }
    const dom = editor.getDomNode();
    if (dom) {
      const onUser = () => {
        userInteracted = true;
      };
      dom.addEventListener('mousedown', onUser);
      dom.addEventListener('keydown', onUser);
    }
    editor.onDidChangeCursorPosition((e) => {
      if (!userInteracted) return;
      onCursorLineChangeRef.current?.(e.position.lineNumber);
    });
  }, []);

  return (
    <Editor
      height="100%"
      language="markdown"
      value={value}
      onChange={(v, event) => {
        onChange(v ?? '');
        if (!event.isFlush) onUserEdit?.();
      }}
      onMount={handleMount}
      theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
      options={{
        minimap: { enabled: false },
        wordWrap: 'on',
        lineNumbers: 'on',
        folding: false,
        fontSize: 13,
        scrollBeyondLastLine: false,
        padding: { top: 12, bottom: 12 },
      }}
    />
  );
}

// ── Header ─────────────────────────────────────────────────────────────────────

interface EditorHeaderProps {
  dirty: boolean;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onOpenExternal?: () => void;
  onDownload?: () => void;
  onDelete?: () => void;
  actions?: React.ReactNode;
  /** Slot rendered to the left of the review/edit mode chips. */
  leadingActions?: React.ReactNode;
  /** Document actions that belong to the current mode (e.g. Copy in view mode). */
  modeActions?: React.ReactNode;
  /** Host ref for Milkdown's edit toolbar, rendered inline after the mode group. */
  editorToolbarHostRef?: (node: HTMLDivElement | null) => void;
  /** Slot rendered inline next to the file name (e.g. the skill eval toggle). */
  nameExtras?: React.ReactNode;
  showLearningMode?: boolean;
}

// Standard mode hides the eval/worker `nameExtras`, the secondary file toolbar
// (copy/open-external/download — Delete stays), and the review/markdown
// editor-mode chips.
function EditorHeader({
  dirty,
  viewMode,
  onViewModeChange,
  onOpenExternal,
  onDownload,
  onDelete,
  actions,
  leadingActions,
  modeActions,
  editorToolbarHostRef,
  nameExtras,
  showLearningMode,
}: EditorHeaderProps) {
  const { t } = useLingui();
  const advanced = useIsAdvanced();
  const visibleModes = EDITOR_MODES.filter((m) => {
    if (m === 'learning') return !!showLearningMode;
    if (!advanced && isAdvancedOnlyMode(m)) return false;
    return true;
  });
  return (
    <div className="flex h-10 flex-shrink-0 items-center gap-2 border-b px-3" data-testid="asset-editor-header">
      <div className="flex flex-shrink-0 items-center rounded-md border bg-muted/40 p-0.5">
        {visibleModes.map((mode) => {
          const Icon = MODE_ICONS[mode];
          const active = viewMode === mode;
          return (
            <button
              key={mode}
              onClick={() => onViewModeChange(mode)}
              title={mode.charAt(0).toUpperCase() + mode.slice(1)}
              data-testid={`editor-mode-chip-${mode}`}
              data-mode-active={active ? 'true' : 'false'}
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium capitalize transition-colors ${
                active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="h-3 w-3" />
              {mode}
            </button>
          );
        })}
        {modeActions}
      </div>

      {viewMode === 'editor' && (
        <div
          ref={editorToolbarHostRef}
          className="min-w-0 flex-1 overflow-x-auto"
          data-testid="markdown-editor-toolbar-host"
        />
      )}

      <div className={`flex flex-shrink-0 items-center gap-1 ${viewMode === 'editor' ? '' : 'ms-auto'}`}>
        {leadingActions}
        {advanced && nameExtras}
        <AssetCollisionBadge />
        {dirty && (
          <span className="text-sm text-amber-500" title={t`Unsaved changes`}>
            *
          </span>
        )}
        {advanced && (
          <button
            type="button"
            title={t`Reveal in Finder`}
            onClick={onOpenExternal}
            data-testid="markdown-editor-open-external"
            className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
        {advanced && onDownload && (
          <button
            type="button"
            title={t`Download file`}
            onClick={onDownload}
            data-testid="markdown-editor-download"
            className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            title={t`Delete file`}
            onClick={onDelete}
            data-testid="markdown-editor-delete"
            className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        {actions}
      </div>
    </div>
  );
}
