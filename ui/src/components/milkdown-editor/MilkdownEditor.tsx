import { Trans, useLingui } from '@lingui/react/macro';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, parserCtx } from '@milkdown/core';
import { Milkdown, MilkdownProvider, useEditor, useInstance } from '@milkdown/react';
import {
  commonmark,
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  wrapInHeadingCommand,
  turnIntoTextCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  createCodeBlockCommand,
  linkSchema,
} from '@milkdown/preset-commonmark';
import { gfm, insertTableCommand } from '@milkdown/preset-gfm';
import { tableBlock } from '@milkdown/components/table-block';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { prism, prismConfig } from '@milkdown/plugin-prism';
import { emoji } from '@milkdown/plugin-emoji';
import { history } from '@milkdown/plugin-history';
import { trailing } from '@milkdown/plugin-trailing';
import { callCommand } from '@milkdown/utils';
import type { MilkdownPlugin } from '@milkdown/ctx';
import type { Ctx } from '@milkdown/ctx';
import type { EditorState } from '@milkdown/prose/state';
import { TextSelection } from '@milkdown/prose/state';
import type { MarkType } from '@milkdown/prose/model';
import type { EditorView } from '@milkdown/prose/view';
import { dataContext, VFSPath, type TypeId } from '@sdk';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { FilePreviewSheet, type FilePreviewTarget } from '@src/components/file-preview/FilePreviewSheet';
import {
  Bold, Italic, Code, Heading1, Heading2, Heading3,
  List, ListOrdered, SquareCode, Pilcrow, ExternalLink,
  Link as LinkIcon, Check, X, Pencil, Unlink,
  ChevronsRight, ChevronsLeft, Languages,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  Table as TableIcon,
} from 'lucide-react';

import './milkdown.css';
import './plugins/fence-render/fence-render.css';
import { configureRefractor } from './plugins/prism-languages';
import { fenceRenderPlugins, fenceHostServicesCtx, type FenceHostServices } from './plugins/fence-render';
// Concrete fence renderers self-register on import. Listed here, at the
// composition point, rather than inside the plugin — the same direction
// `AssetsPage` imports its column modules, and it keeps `fence-render/` free of
// any dependency on the renderers built on top of it.
import './plugins/fence-render/renderers/mermaid';
import './plugins/fence-render/renderers/interface';
import {
  bidiPlugins,
  setDirCommand, unsetDirCommand,
  setAlignCommand, unsetAlignCommand,
  type BidiDir, type BidiAlign,
} from './plugins/bidi';

/**
 * Strip HTML comments from markdown content for display.
 * Comments like <!-- ... --> are hidden in WYSIWYG mode.
 */
function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '');
}

// Round-trippable wikilink ↔ markdown-link transform. Milkdown's CommonMark
// preset doesn't recognize `[[..]]`, so we rewrite it to the markdown URL
// form on the way in (clickable), and reverse on the way out (preserves
// `[[..]]` in the source file).
const _WIKILINK_DISPLAY_RE = /(?<!\\)\[\[([^[\]\n|#^]+)(?:\|([^[\]\n]+))?\]\]/g;
const _DOCK_WIKI_HREF_RE = /\[([^\]\n]+)\]\(\/dock\/assets\/wiki\/([^)\s#]+)\)/g;

function wikilinksToMdLinks(md: string): string {
  return md.replace(_WIKILINK_DISPLAY_RE, (_match, target: string, alias: string | undefined) => {
    const t = target.trim();
    const display = (alias ?? t).trim();
    return `[${display}](/dock/assets/wiki/${encodeURIComponent(t)})`;
  });
}

function mdLinksToWikilinks(md: string): string {
  return md.replace(_DOCK_WIKI_HREF_RE, (_match, text: string, encoded: string) => {
    const target = decodeURIComponent(encoded);
    if (text === target) return `[[${target}]]`;
    return `[[${target}|${text}]]`;
  });
}

/**
 * Returns the 1-indexed start line of each top-level CommonMark block in the body.
 *
 * Used to map ProseMirror's top-level child index ↔ body line number for the
 * caret-line tracking feature. Recognizes paragraphs, headings, lists, fenced
 * code blocks (treated as one block; internal blank lines don't split). Top-level
 * HTML comment blocks are an edge case where this can drift from the rendered
 * doc's child count — accepted approximation for v1.
 */
function getBlockStartLines(body: string): number[] {
  const lines = body.split('\n');
  const starts: number[] = [];
  let inFence = false;
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isFenceMarker = /^\s*(```|~~~)/.test(line);
    if (inFence) {
      if (isFenceMarker) inFence = false;
      continue;
    }
    if (isFenceMarker) {
      starts.push(i + 1);
      inFence = true;
      inBlock = true;
      continue;
    }
    if (!line.trim()) {
      inBlock = false;
      continue;
    }
    if (!inBlock) {
      starts.push(i + 1);
      inBlock = true;
    }
  }
  return starts;
}

/**
 * A project's absolute root directory on disk.
 *
 * `fs_storage_mount_path` is the field that actually holds it — it is what
 * `Project.getProjectByPath` longest-prefix-matches against. `cwd` is a
 * secondary. Deliberately NO `name` fallback: a project's name is not a path,
 * and falling back to it silently produced a *relative* root that resolved
 * source pointers to unopenable paths.
 */
function projectRootOf(
  project: { fs_storage_mount_path?: string | null; cwd?: string | null } | null | undefined,
): string | null {
  const root = project?.fs_storage_mount_path || project?.cwd || '';
  return root.startsWith('/') ? root : null;
}

/** Top-level child index of the caret in the doc, or null if not resolvable. */
function caretBlockIndex(view: EditorView): number | null {
  const sel = view.state.selection;
  if (!sel) return null;
  const $from = sel.$from;
  if ($from.depth === 0) return null;
  return $from.index(0);
}

/**
 * Modes the Milkdown WYSIWYG renderer understands.
 * Raw-markdown ('markdown') is rendered by a separate Monaco pane in wrappers,
 * never by this component.
 */
export type MilkdownEditorMode = 'view' | 'review' | 'editor';

interface MilkdownEditorProps {
  content: string;
  onChange?: (content: string) => void;
  /** Defaults to 'editor'. 'view' and 'review' disable editing and hide the toolbar. */
  editorMode?: MilkdownEditorMode;
  plugins?: MilkdownPlugin[];
  onLinkClick?: (href: string) => void;
  /**
   * Optional outer ref that mirrors the internal editor instance. Lets host
   * components (e.g. the wiki toolbar) issue ProseMirror transactions like
   * `editorRef.current?.action((ctx) => ...)`.
   */
  editorRef?: React.MutableRefObject<Editor | null>;
  /**
   * Slot rendered at the right end of the static toolbar bar. Used by the
   * MarkdownEditor to inject wiki actions ("Add entity link") next to the
   * built-in Bold/Italic/Heading buttons. Inherits the toolbar's edit-mode
   * gating — hidden in view/review modes.
   */
  toolbarRight?: React.ReactNode;
  /**
   * Fires when the caret moves to a different top-level block. The `bodyLine`
   * is 1-indexed against the `content` prop (body markdown). Approximate when
   * the caret lands inside a multi-line block (returns the block's start line).
   */
  onCursorLineChange?: (bodyLine: number) => void;
  /**
   * 1-indexed body line to restore the caret to on mount. Captured at first
   * render — later prop changes do not move the caret.
   */
  initialLine?: number | null;
  /**
   * Document-wide base direction sourced from the file's `direction` frontmatter
   * key (`ltr` | `rtl`). When set, applied as `dir=...` on the editor wrapper —
   * blockquote bars, list bullets, indent, and table cell alignment flip to the
   * correct side via CSS logical properties. Omit (or pass `undefined`) for the
   * default LTR behavior with no `dir` attribute emitted.
   */
  direction?: 'ltr' | 'rtl';
}

// ── Link popup (hover + toolbar) ──────────────────────────────────────────────

type LinkPopupState =
  | { mode: 'view'; rect: DOMRect; href: string; anchor: HTMLElement }
  | { mode: 'edit'; rect: DOMRect; href: string; range: { from: number; to: number } }
  | { mode: 'new'; rect: DOMRect; href: string; range: { from: number; to: number } };

function LinkPopup({
  state,
  onOpen,
  onEdit,
  onApply,
  onRemove,
  onClose,
  onMouseEnter,
  onMouseLeave,
}: {
  state: LinkPopupState;
  onOpen: (href: string) => void;
  onEdit: () => void;
  onApply: (href: string) => void;
  onRemove: () => void;
  onClose: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const { t } = useLingui();
  const { rect, mode, href } = state;
  const [value, setValue] = useState(href);
  useEffect(() => { setValue(href); }, [href, mode]);

  const showAbove = rect.top > 56;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - 320);
  const isInput = mode === 'edit' || mode === 'new';

  return (
    <div
      style={{
        position: 'fixed',
        top: showAbove ? rect.top - 4 : rect.bottom + 4,
        left,
        transform: showAbove ? 'translateY(-100%)' : 'none',
        zIndex: 9999,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="flex items-center gap-1.5 rounded-md border bg-popover px-2 py-1 shadow-md"
      data-testid="milkdown-link-popup"
      data-mode={mode}
    >
      {isInput ? (
        <>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); onApply(value.trim()); }
              else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }}
            placeholder="https://..."
            className="h-6 w-[240px] rounded border bg-transparent px-1.5 text-xs outline-none focus:border-primary"
            data-testid="milkdown-link-input"
          />
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); onApply(value.trim()); }}
            title={t`Apply`}
            className="flex items-center rounded px-1 py-0.5 text-xs hover:bg-muted"
            data-testid="milkdown-link-apply"
          >
            <Check className="h-3 w-3" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); onClose(); }}
            title={t`Cancel`}
            className="flex items-center rounded px-1 py-0.5 text-xs hover:bg-muted"
          >
            <X className="h-3 w-3" />
          </button>
        </>
      ) : (
        <>
          <span className="max-w-[180px] truncate text-xs text-muted-foreground">{href}</span>
          <div className="h-3.5 w-px bg-border" />
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onOpen(href); }}
            className="flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium hover:bg-muted"
            title={t`Open link`}
          >
            <ExternalLink className="h-3 w-3" />
            <Trans>Open</Trans>
          </button>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onEdit(); }}
            className="flex items-center rounded px-1 py-0.5 text-xs hover:bg-muted"
            title={t`Edit link`}
            data-testid="milkdown-link-edit"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}
            className="flex items-center rounded px-1 py-0.5 text-xs hover:bg-muted"
            title={t`Remove link`}
            data-testid="milkdown-link-remove"
          >
            <Unlink className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  );
}

// Find the contiguous link-mark run containing `pos`. Returns ProseMirror range + href, or null.
function findLinkRangeAtPos(
  state: EditorState,
  linkType: MarkType,
  pos: number,
): { from: number; to: number; href: string } | null {
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const parentStart = $pos.start();
  const parentOffset = $pos.parentOffset;

  const markAt = (offset: number): string | null => {
    if (offset < 0 || offset >= parent.content.size) return null;
    const after = parent.childAfter(offset);
    if (!after.node) return null;
    const mark = after.node.marks.find((m) => m.type === linkType);
    return mark ? (mark.attrs.href as string) : null;
  };

  let href = markAt(parentOffset);
  if (!href && parentOffset > 0) href = markAt(parentOffset - 1);
  if (!href) return null;

  let acc = parentStart;
  let from = -1;
  let to = -1;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    const childStart = acc;
    const childEnd = acc + child.nodeSize;
    const m = child.marks.find((mm) => mm.type === linkType);
    const sameRun = m && m.attrs.href === href;
    if (sameRun) {
      if (from === -1) from = childStart;
      to = childEnd;
    } else if (from !== -1 && pos >= from && pos <= to) {
      return { from, to, href };
    } else {
      from = -1;
      to = -1;
    }
    acc = childEnd;
  }
  if (from !== -1 && pos >= from && pos <= to) return { from, to, href };
  return null;
}

// Find the ProseMirror position of an anchor DOM element (the first text descendant).
function posForAnchor(view: EditorView, anchor: HTMLElement): number | null {
  const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
  const first = walker.nextNode();
  if (!first) return null;
  try {
    return view.posAtDOM(first, 0);
  } catch {
    return null;
  }
}

// ── Toolbar active state ──────────────────────────────────────────────────────

/**
 * `null` ≡ attr is unset on every paragraph/heading in the selection (the
 * default — no DOM `dir` attribute emitted). `'mixed'` ≡ the selection
 * crosses paragraphs with different values. Otherwise the shared value
 * across the selection.
 */
type BidiActiveDir = 'ltr' | 'rtl' | 'auto' | null | 'mixed';
type BidiActiveAlign = 'start' | 'end' | 'center' | 'justify' | null | 'mixed';

interface ActiveState {
  bold: boolean;
  italic: boolean;
  inlineCode: boolean;
  headingLevel: number; // 0 = not a heading
  bulletList: boolean;
  orderedList: boolean;
  codeBlock: boolean;
  link: boolean;        // cursor is inside or selection contains a link
  canAddLink: boolean;  // selection is non-empty, not already a link, not in code block
  bidiDir: BidiActiveDir;
  bidiAlign: BidiActiveAlign;
}

const EMPTY_ACTIVE: ActiveState = {
  bold: false, italic: false, inlineCode: false,
  headingLevel: 0, bulletList: false, orderedList: false, codeBlock: false,
  link: false, canAddLink: false,
  bidiDir: null,
  bidiAlign: null,
};

function getActiveState(state: EditorState): ActiveState {
  const { selection, schema } = state;
  const $from = selection?.$from;
  if (!$from) return EMPTY_ACTIVE;

  const { from, to, empty } = selection;
  const markActive = (markName: string): boolean => {
    const markType = schema.marks[markName];
    if (!markType) return false;
    if (empty) return !!(state.storedMarks || $from.marks()).find(m => m.type === markType);
    return state.doc.rangeHasMark(from, to, markType);
  };

  const bold = markActive('strong');
  const italic = markActive('em');
  const inlineCode = markActive('code');
  const link = markActive('link');

  const parent = $from.parent;
  const headingLevel = parent.type.name === 'heading' ? (parent.attrs.level as number) : 0;
  const codeBlock = parent.type.name === 'code_block' || parent.type.name === 'fence';

  let bulletList = false;
  let orderedList = false;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'bullet_list') bulletList = true;
    if (node.type.name === 'ordered_list') orderedList = true;
  }

  const canAddLink = !empty && !link && !codeBlock;

  // Compute the selection's effective bidi direction and alignment. Only
  // paragraph and heading are bidi-bearing in phases 4–5. A selection
  // crossing nodes with different values surfaces as 'mixed' — the toolbar
  // shows no button as pressed but the first click resolves the whole
  // selection.
  let bidiDir: BidiActiveDir | undefined;
  let bidiAlign: BidiActiveAlign | undefined;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isTextblock) return;
    if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return;
    const nodeDir = (node.attrs.dir ?? null) as BidiActiveDir;
    const nodeAlign = (node.attrs.align ?? null) as BidiActiveAlign;
    if (bidiDir === undefined) bidiDir = nodeDir;
    else if (bidiDir !== nodeDir) bidiDir = 'mixed';
    if (bidiAlign === undefined) bidiAlign = nodeAlign;
    else if (bidiAlign !== nodeAlign) bidiAlign = 'mixed';
  });
  // Empty selection that didn't hit any block above (defensive — shouldn't
  // happen given $from.parent, but nodesBetween treats from===to as empty).
  if (bidiDir === undefined || bidiAlign === undefined) {
    const p = $from.parent;
    const inBidiBlock = p.type.name === 'paragraph' || p.type.name === 'heading';
    if (bidiDir === undefined) {
      bidiDir = inBidiBlock ? ((p.attrs.dir ?? null) as BidiActiveDir) : null;
    }
    if (bidiAlign === undefined) {
      bidiAlign = inBidiBlock ? ((p.attrs.align ?? null) as BidiActiveAlign) : null;
    }
  }

  return { bold, italic, inlineCode, headingLevel, bulletList, orderedList, codeBlock, link, canAddLink, bidiDir, bidiAlign };
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

interface FormatButtonProps {
  title: string;
  icon: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  testId?: string;
  onMouseDown: (e: React.MouseEvent) => void;
}

/** Shared icon button for both static toolbar and selection popup. */
export function FormatButton({ title, icon, active, disabled, testId, onMouseDown }: FormatButtonProps) {
  return (
    <button
      title={title}
      disabled={disabled}
      onMouseDown={onMouseDown}
      data-testid={testId}
      className={`flex h-7 w-7 items-center justify-center rounded hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground ${
        active ? 'bg-muted text-foreground' : 'text-muted-foreground'
      }`}
    >
      {icon}
    </button>
  );
}

/**
 * Bold + Italic + Inline code + Link cluster — reused by both the static
 * toolbar (along with headings/lists/code-block) and the SelectionToolbar
 * popup (which contains only this cluster).
 */
function TextFormatButtons({
  activeState,
  onRequestLink,
}: {
  activeState: ActiveState;
  onRequestLink: () => void;
}) {
  const { t } = useLingui();
  const [loading, get] = useInstance();
  const act = useCallback(
    (fn: (ctx: Ctx) => void) => {
      if (loading) return;
      get().action(fn);
    },
    [loading, get],
  );
  const { bold, italic, inlineCode, link, canAddLink } = activeState;
  const linkEnabled = link || canAddLink;

  return (
    <>
      <FormatButton
        title={t`Bold`}
        icon={<Bold className="h-3.5 w-3.5" />}
        active={bold}
        onMouseDown={(e) => { e.preventDefault(); act(callCommand(toggleStrongCommand.key)); }}
      />
      <FormatButton
        title={t`Italic`}
        icon={<Italic className="h-3.5 w-3.5" />}
        active={italic}
        onMouseDown={(e) => { e.preventDefault(); act(callCommand(toggleEmphasisCommand.key)); }}
      />
      <FormatButton
        title={t`Inline code`}
        icon={<Code className="h-3.5 w-3.5" />}
        active={inlineCode}
        onMouseDown={(e) => { e.preventDefault(); act(callCommand(toggleInlineCodeCommand.key)); }}
      />
      <FormatButton
        title={link ? t`Edit link` : canAddLink ? t`Add link` : t`Select text to add a link`}
        icon={<LinkIcon className="h-3.5 w-3.5" />}
        active={link}
        disabled={!linkEnabled}
        testId="milkdown-toolbar-link"
        onMouseDown={(e) => { e.preventDefault(); if (linkEnabled) onRequestLink(); }}
      />
    </>
  );
}

function MilkdownToolbar({
  activeState,
  onRequestLink,
  rightSlot,
}: {
  activeState: ActiveState;
  onRequestLink: () => void;
  rightSlot?: React.ReactNode;
}) {
  const { t } = useLingui();
  const [loading, get] = useInstance();

  const act = useCallback(
    (fn: (ctx: Ctx) => void) => {
      if (loading) return;
      get().action(fn);
    },
    [loading, get],
  );

  const headingBtn = (title: string, icon: React.ReactNode, fn: (ctx: Ctx) => void, active = false) => (
    <FormatButton
      title={title}
      icon={icon}
      active={active}
      onMouseDown={(e) => { e.preventDefault(); act(fn); }}
    />
  );

  const { headingLevel, bulletList, orderedList, codeBlock, bidiDir, bidiAlign } = activeState;

  // Direction / alignment button click handlers: clicking the active button
  // clears the attr (back to default null); clicking an inactive button or
  // while 'mixed' sets that value across the whole selection.
  const onDirClick = (target: BidiDir) => {
    if (bidiDir === target) act(callCommand(unsetDirCommand.key));
    else act(callCommand(setDirCommand.key, target));
  };
  const onAlignClick = (target: BidiAlign) => {
    if (bidiAlign === target) act(callCommand(unsetAlignCommand.key));
    else act(callCommand(setAlignCommand.key, target));
  };
  // Direction / alignment controls are nonsensical inside code blocks
  // (always LTR, no line-level alignment) — disable both groups there.
  const dirDisabled = codeBlock;
  const alignDisabled = codeBlock;

  return (
    <div className="flex flex-shrink-0 items-center gap-0.5 border-b bg-muted/20 px-2 py-1">
      <TextFormatButtons activeState={activeState} onRequestLink={onRequestLink} />
      <div className="mx-1.5 h-4 w-px bg-border" />
      {headingBtn(t`Normal text`, <Pilcrow className="h-3.5 w-3.5" />, callCommand(turnIntoTextCommand.key), headingLevel === 0 && !codeBlock)}
      {headingBtn(t`Heading 1`, <Heading1 className="h-3.5 w-3.5" />, callCommand(wrapInHeadingCommand.key, 1), headingLevel === 1)}
      {headingBtn(t`Heading 2`, <Heading2 className="h-3.5 w-3.5" />, callCommand(wrapInHeadingCommand.key, 2), headingLevel === 2)}
      {headingBtn(t`Heading 3`, <Heading3 className="h-3.5 w-3.5" />, callCommand(wrapInHeadingCommand.key, 3), headingLevel === 3)}
      <div className="mx-1.5 h-4 w-px bg-border" />
      {headingBtn(t`Bullet list`, <List className="h-3.5 w-3.5" />, callCommand(wrapInBulletListCommand.key), bulletList)}
      {headingBtn(t`Ordered list`, <ListOrdered className="h-3.5 w-3.5" />, callCommand(wrapInOrderedListCommand.key), orderedList)}
      {headingBtn(t`Code block`, <SquareCode className="h-3.5 w-3.5" />, callCommand(createCodeBlockCommand.key), codeBlock)}
      <FormatButton
        title={t`Insert table`}
        icon={<TableIcon className="h-3.5 w-3.5" />}
        testId="milkdown-toolbar-table"
        onMouseDown={(e) => { e.preventDefault(); act(callCommand(insertTableCommand.key, { row: 3, col: 3 })); }}
      />
      <div className="mx-1.5 h-4 w-px bg-border" />
      <FormatButton
        title={t`Left-to-right paragraph`}
        icon={<ChevronsRight className="h-3.5 w-3.5" />}
        active={bidiDir === 'ltr'}
        disabled={dirDisabled}
        testId="milkdown-toolbar-dir-ltr"
        onMouseDown={(e) => { e.preventDefault(); if (!dirDisabled) onDirClick('ltr'); }}
      />
      <FormatButton
        title={t`Right-to-left paragraph`}
        icon={<ChevronsLeft className="h-3.5 w-3.5" />}
        active={bidiDir === 'rtl'}
        disabled={dirDisabled}
        testId="milkdown-toolbar-dir-rtl"
        onMouseDown={(e) => { e.preventDefault(); if (!dirDisabled) onDirClick('rtl'); }}
      />
      <FormatButton
        title={t`Auto-detect direction from first strong character`}
        icon={<Languages className="h-3.5 w-3.5" />}
        active={bidiDir === 'auto'}
        disabled={dirDisabled}
        testId="milkdown-toolbar-dir-auto"
        onMouseDown={(e) => { e.preventDefault(); if (!dirDisabled) onDirClick('auto'); }}
      />
      <div className="mx-1.5 h-4 w-px bg-border" />
      {/*
        Alignment buttons use logical values (start/end/center/justify). The
        AlignLeft / AlignRight icons are physical and don't flip with text
        direction — but the *behavior* (`text-align: start|end`) always
        follows the paragraph's resolved direction. Matches Word's UX:
        users recognize the icons; under the hood, "start" sits on the
        right side in an RTL paragraph.
      */}
      <FormatButton
        title={t`Align start (left in LTR, right in RTL)`}
        icon={<AlignLeft className="h-3.5 w-3.5" />}
        active={bidiAlign === 'start'}
        disabled={alignDisabled}
        testId="milkdown-toolbar-align-start"
        onMouseDown={(e) => { e.preventDefault(); if (!alignDisabled) onAlignClick('start'); }}
      />
      <FormatButton
        title={t`Align center`}
        icon={<AlignCenter className="h-3.5 w-3.5" />}
        active={bidiAlign === 'center'}
        disabled={alignDisabled}
        testId="milkdown-toolbar-align-center"
        onMouseDown={(e) => { e.preventDefault(); if (!alignDisabled) onAlignClick('center'); }}
      />
      <FormatButton
        title={t`Align end (right in LTR, left in RTL)`}
        icon={<AlignRight className="h-3.5 w-3.5" />}
        active={bidiAlign === 'end'}
        disabled={alignDisabled}
        testId="milkdown-toolbar-align-end"
        onMouseDown={(e) => { e.preventDefault(); if (!alignDisabled) onAlignClick('end'); }}
      />
      <FormatButton
        title={t`Justify`}
        icon={<AlignJustify className="h-3.5 w-3.5" />}
        active={bidiAlign === 'justify'}
        disabled={alignDisabled}
        testId="milkdown-toolbar-align-justify"
        onMouseDown={(e) => { e.preventDefault(); if (!alignDisabled) onAlignClick('justify'); }}
      />
      {rightSlot && (
        <>
          <div className="mx-1.5 h-4 w-px bg-border" />
          {rightSlot}
        </>
      )}
    </div>
  );
}

// ── Selection toolbar popup ──────────────────────────────────────────────────

interface SelectionRect {
  top: number;
  left: number;
  width: number;
}

function computeSelectionRect(view: EditorView): SelectionRect | null {
  const { from, to, empty } = view.state.selection;
  if (empty) return null;
  try {
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);
    const top = Math.min(start.top, end.top);
    const left = Math.min(start.left, end.left);
    const right = Math.max(start.right, end.right);
    return { top, left, width: right - left };
  } catch {
    return null;
  }
}

/**
 * Floating toolbar that appears above the current text selection.
 * Reuses TextFormatButtons (Bold/Italic/Code/Link) — same buttons as the
 * static toolbar's first cluster, same active state, same commands.
 */
function SelectionToolbar({
  rect,
  activeState,
  onRequestLink,
}: {
  rect: SelectionRect | null;
  activeState: ActiveState;
  onRequestLink: () => void;
}) {
  const { t } = useLingui();
  if (!rect) return null;
  // Position the popup ~36px above the selection, flipping below if too close to top.
  const POPUP_HEIGHT = 36;
  const GAP = 8;
  const flipBelow = rect.top - POPUP_HEIGHT - GAP < 8;
  const top = flipBelow ? rect.top + 24 : rect.top - POPUP_HEIGHT - GAP;
  const left = rect.left + rect.width / 2;
  return (
    <div
      role="toolbar"
      aria-label={t`Selection toolbar`}
      data-testid="selection-toolbar"
      style={{
        position: 'fixed',
        top,
        left,
        transform: 'translateX(-50%)',
        zIndex: 50,
      }}
      className="flex items-center gap-0.5 rounded-md border border-border bg-popover p-1 shadow-md"
      onMouseDown={(e) => e.preventDefault()}
    >
      <TextFormatButtons activeState={activeState} onRequestLink={onRequestLink} />
    </div>
  );
}

// ── Editor inner ──────────────────────────────────────────────────────────────

function MilkdownEditorInner({ content, onChange, editorMode, plugins, onActiveStateChange, onSelectionRectChange, onCursorLineChange, initialLine, direction, editorRef }: MilkdownEditorProps & { onActiveStateChange?: (s: ActiveState) => void; onSelectionRectChange?: (r: SelectionRect | null) => void; editorRef?: React.MutableRefObject<Editor | null> }) {
  const isReadOnly = editorMode === 'view' || editorMode === 'review';
  const { navigation, currentDock } = useDockNavigation();
  const [previewTarget, setPreviewTarget] = useState<FilePreviewTarget | null>(null);

  /** The entity files are addressed through — the document's own compute node. */
  const docEntityTypeId = (): TypeId =>
    VFSPath.parse(currentDock?.pointer ?? '').typeId ?? LOCAL_COMPUTE_NODE;

  const openMachinePath = (path: string, options?: { line?: number }) => {
    navigation.openFile(VFSPath.fromMachinePath(path, docEntityTypeId()).rawPath, options);
  };

  /*
   * Capabilities lent to fence renderers (see `plugins/fence-render/host-services`).
   * Held in a ref because the Milkdown editor is constructed once: the ctx slice
   * closes over this ref, so navigation and the active project stay current
   * without rebuilding the editor.
   *
   * `projectRootById` only answers for the project already in context. There is
   * no by-id project fetch in the SDK today (`Project` exposes `getProjectByPath`,
   * not a get-by-id), and firing a query per rendered block would be worse than
   * a clear "not open" reason on the button.
   */
  const hostServicesRef = useRef<FenceHostServices>({
    openFile: () => {},
    previewFile: () => {},
    documentProjectRoot: () => null,
    projectRootById: () => null,
  });
  hostServicesRef.current = {
    // Renderers resolve to an ABSOLUTE MACHINE path; editor docks address files
    // as VFS paths (`compute_node-<id>/abs/path`). Converting here keeps that
    // convention at the app boundary instead of teaching every renderer about
    // compute nodes — without it the dock URL loses the entity prefix and the
    // code editor never resolves the file. The entity comes from the DOCUMENT's
    // own dock, so source opens on the compute node the doc is read on;
    // `LOCAL_COMPUTE_NODE` is only a fallback (it serializes to the `@local`
    // uname, which the code editor does not resolve to a filesystem).
    openFile: (path, options) => openMachinePath(path, options),
    previewFile: (path, options) =>
      setPreviewTarget({ path, line: options?.line, typeId: docEntityTypeId() }),
    documentProjectRoot: () => projectRootOf(dataContext.project),
    projectRootById: (projectId) =>
      dataContext.project?.id === projectId ? projectRootOf(dataContext.project) : null,
  };

  const localRef = useRef<Editor | null>(null);
  const setEditor = (e: Editor | null) => {
    localRef.current = e;
    if (editorRef) editorRef.current = e;
  };

  // Strip HTML comments + rewrite [[wikilinks]] → markdown-link form so
  // CommonMark renders them as clickable anchors. Reverse on save.
  const displayContent = useMemo(
    () => wikilinksToMdLinks(stripHtmlComments(content)),
    [content],
  );
  const initialContentRef = useRef(displayContent);
  // Track the last markdown we emitted via onChange so we can tell user edits
  // apart from external content changes (e.g. file rewritten on disk).
  const lastEmittedRef = useRef(displayContent);
  // Live mirror of isReadOnly so ProseMirror's `editable` closure reads current value.
  const isReadOnlyRef = useRef(isReadOnly);
  isReadOnlyRef.current = isReadOnly;

  // Block-start-line table, kept in sync with the original `content` (body)
  // — Monaco shows body line numbers, so this stays body-relative.
  const blockLinesRef = useRef<number[]>(getBlockStartLines(content));
  useEffect(() => {
    blockLinesRef.current = getBlockStartLines(content);
  }, [content]);

  // Captured once at first render — initialLine is a "place caret here on mount"
  // signal, not a controlled prop. Later changes from the parent (which feeds
  // back the line we ourselves emitted) don't reapply.
  const initialLineRef = useRef(initialLine ?? null);
  const restoredRef = useRef(false);

  const onCursorLineChangeRef = useRef(onCursorLineChange);
  onCursorLineChangeRef.current = onCursorLineChange;
  const lastEmittedLineRef = useRef<number | null>(null);
  // Suppress emissions until the user actually interacts with the editor —
  // selectionUpdated fires once on mount (Milkdown initializes a default
  // selection at position 0), and we don't want that to drive the chat badge.
  // Programmatic caret restoration also marks this true so the badge survives
  // mode switches.
  const userInteractedRef = useRef(false);

  // Keep ref in sync so editor uses latest content when re-initialized (e.g. after save)
  useEffect(() => {
    initialContentRef.current = displayContent;
  }, [displayContent]);

  const { get } = useEditor(
    (root) => {
      const editor = Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, initialContentRef.current);
          // Read-only modes disable editing but keep the DOM interactive
          // (anchors remain clickable, hover events still fire).
          // Register the grammars refractor's common bundle lacks. Must be
          // set before `prism` builds its decoration plugin.
          ctx.set(prismConfig.key, { configureRefractor });
          // Lend fence renderers the app capabilities they can't reach from a
          // NodeView. Backed by a ref so the values stay live for the life of
          // the editor rather than freezing at construction.
          ctx.set(fenceHostServicesCtx.key, {
            openFile: (path, options) => hostServicesRef.current.openFile(path, options),
            previewFile: (path, options) => hostServicesRef.current.previewFile(path, options),
            documentProjectRoot: () => hostServicesRef.current.documentProjectRoot(),
            projectRootById: (id) => hostServicesRef.current.projectRootById(id),
          });
          ctx.update(editorViewOptionsCtx, (prev) => ({
            ...prev,
            editable: () => !isReadOnlyRef.current,
          }));
          const lctx = ctx.get(listenerCtx);
          if (onChange) {
            lctx.markdownUpdated((_, markdown) => {
              // Track Milkdown's emit verbatim for change detection vs
              // displayContent (also markdown-link form). Reverse the
              // transform only on the way out to onChange.
              lastEmittedRef.current = markdown;
              onChange(mdLinksToWikilinks(markdown));
            });
          }
          const notify = (ctx: Ctx) => {
            try {
              const view = ctx.get(editorViewCtx);
              onActiveStateChange?.(getActiveState(view.state));
              onSelectionRectChange?.(computeSelectionRect(view));
              const emit = onCursorLineChangeRef.current;
              if (emit && userInteractedRef.current) {
                const blockIdx = caretBlockIndex(view);
                if (blockIdx != null) {
                  const table = blockLinesRef.current;
                  const line = blockIdx < table.length ? table[blockIdx] : (table[table.length - 1] ?? 1);
                  if (line !== lastEmittedLineRef.current) {
                    lastEmittedLineRef.current = line;
                    emit(line);
                  }
                }
              }
            } catch {
              // view not ready during initialization
            }
          };
          // Fire on document changes — debounced 200ms so view.state is already updated
          lctx.updated((ctx) => notify(ctx));
          // selectionUpdated fires synchronously during apply (view.state is still old),
          // so defer by one tick to read the updated view.state
          lctx.selectionUpdated((ctx) => setTimeout(() => notify(ctx), 0));
        })
        .use(commonmark)
        .use(gfm)
        .use(tableBlock)
        .use(listener)
        .use(prism)
        .use(emoji)
        .use(history)
        .use(trailing)
        // Phase 3 of RTL/LTR support: extends paragraph + heading with `dir`
        // and `align` attrs, registers a remark transformer that lifts
        // `<p dir>` / `<h* dir>` HTML wrappers in source markdown into those
        // attrs, and re-emits the wrappers on serialize when attrs are
        // non-default. Default-attr nodes round-trip byte-identical to the
        // unmodified commonmark output.
        .use(bidiPlugins)
        // Renderable code fences (```mermaid → diagram) with a Render | Code
        // tab strip. Render-only: no schema, parser or serializer changes, so
        // fence markdown round-trips byte-identically.
        .use(fenceRenderPlugins);

      // Register extra plugins (e.g. plan-note mark)
      if (plugins) {
        for (const plugin of plugins) {
          editor.use(plugin);
        }
      }

      return editor;
    },
    [onChange, onActiveStateChange, onSelectionRectChange, plugins],
  );

  useEffect(() => {
    if (get) {
      setEditor(get() ?? null);
    }
  }, [get]);

  // One-shot caret restoration: when the editor instance becomes available and
  // an `initialLine` was supplied at mount, place the caret at the start of the
  // top-level block whose start-line ≤ initialLine. Runs at most once per mount.
  useEffect(() => {
    if (restoredRef.current) return;
    const editor = get?.();
    if (!editor) return;
    const target = initialLineRef.current;
    if (target == null) {
      restoredRef.current = true;
      return;
    }
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const table = blockLinesRef.current;
        if (table.length === 0) return;
        let blockIdx = 0;
        for (let i = 0; i < table.length; i++) {
          if (table[i] <= target) blockIdx = i;
          else break;
        }
        const doc = view.state.doc;
        if (blockIdx >= doc.childCount) blockIdx = doc.childCount - 1;
        let pos = 0;
        for (let j = 0; j < blockIdx; j++) pos += doc.child(j).nodeSize;
        // Step inside the block (past its opening token) so the caret lands in content.
        pos += 1;
        const sel = TextSelection.create(doc, Math.min(pos, doc.content.size));
        view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
        lastEmittedLineRef.current = table[blockIdx];
        // Treat restoration as interaction so the badge persists across mode swaps.
        userInteractedRef.current = true;
      });
    } catch {
      // view not ready yet — try again on next render via the same guard
      return;
    }
    restoredRef.current = true;
  }, [get]);

  // Mark the editor as "user-interacted" on first real input so the chat-line
  // badge stays hidden until the user clicks/types. mousedown + keydown cover
  // both pointer and keyboard navigation.
  useEffect(() => {
    const editor = get?.();
    if (!editor) return;
    const onUser = () => { userInteractedRef.current = true; };
    let dom: HTMLElement | null = null;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        dom = view.dom;
        view.dom.addEventListener('mousedown', onUser);
        view.dom.addEventListener('keydown', onUser);
      });
    } catch {
      // view not ready yet
    }
    return () => {
      if (!dom) return;
      dom.removeEventListener('mousedown', onUser);
      dom.removeEventListener('keydown', onUser);
    };
  }, [get]);

  // Toggle editable on mode change. setProps forces ProseMirror to re-read the
  // editable closure (which is backed by isReadOnlyRef) and update contenteditable.
  useEffect(() => {
    const editor = get?.();
    if (!editor) return;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.setProps({ editable: () => !isReadOnlyRef.current });
      });
    } catch {
      // view not ready yet — initial config already applied the correct value
    }
  }, [isReadOnly, get]);

  // Sync external content changes into the live ProseMirror doc.
  // useEditor's dep array doesn't include content, so without this the editor
  // keeps its initial state when the file is rewritten on disk.
  useEffect(() => {
    const editor = get?.();
    if (!editor) return;
    if (displayContent === lastEmittedRef.current) return;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const parser = ctx.get(parserCtx);
        const newDoc = parser(displayContent);
        if (!newDoc) return;
        const { state } = view;
        view.dispatch(state.tr.replaceWith(0, state.doc.content.size, newDoc.content));
      });
      lastEmittedRef.current = displayContent;
    } catch (err) {
      console.error('[MilkdownEditor] Failed to sync external content:', err);
    }
  }, [displayContent, get]);

  return (
    <div className="milkdown-editor-wrapper h-full" dir={direction}>
      <Milkdown />
      {/*
        Rendered by the editor, not the renderer: a fence NodeView is plain DOM
        with no React tree to mount a sheet into, so it asks the host via
        `previewFile` and the host owns the surface.
      */}
      <FilePreviewSheet
        target={previewTarget}
        onClose={() => setPreviewTarget(null)}
        onOpen={(target) => {
          setPreviewTarget(null);
          openMachinePath(target.path, { line: target.line });
        }}
      />
    </div>
  );
}

export function MilkdownEditor({ content, onChange, editorMode = 'editor', plugins, onLinkClick, editorRef: externalEditorRef, toolbarRight, onCursorLineChange, initialLine, direction }: MilkdownEditorProps) {
  const isReadOnly = editorMode === 'view' || editorMode === 'review';
  const [activeState, setActiveState] = useState<ActiveState>(EMPTY_ACTIVE);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const [linkPopup, setLinkPopup] = useState<LinkPopupState | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const internalEditorRef = useRef<Editor | null>(null);
  const editorRef = externalEditorRef ?? internalEditorRef;

  useEffect(() => () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); }, []);

  // Clear any open link popup when switching into view mode.
  useEffect(() => {
    if (editorMode === 'view') setLinkPopup(null);
  }, [editorMode]);

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
  }, []);

  const scheduleHide = useCallback(() => {
    cancelHide();
    hideTimerRef.current = setTimeout(() => {
      setLinkPopup((current) => (current?.mode === 'view' ? null : current));
    }, 300);
  }, [cancelHide]);

  const handleMouseOver = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // View mode is wiki-style: no hover popup, clicks open directly.
    if (editorMode === 'view') return;
    const anchor = (e.target as HTMLElement).closest('a') as HTMLElement | null;
    if (anchor) {
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      cancelHide();
      setLinkPopup((current) => {
        if (current && current.mode !== 'view') return current; // don't override edit/new while user is typing
        return { mode: 'view', href, rect: anchor.getBoundingClientRect(), anchor };
      });
    } else {
      scheduleHide();
    }
  }, [cancelHide, scheduleHide, editorMode]);

  // Intercept anchor clicks across all modes — wiki/internal hrefs (e.g.
  // /dock/assets/wiki/...) are SPA routes the browser can't resolve on its
  // own; default-navigation would land on a 404. ProseMirror's mousedown
  // already placed the caret by the time click fires, so editing isn't
  // broken; editing the link itself still goes through the hover popup.
  const handleContainerClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a') as HTMLElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    if (/^https?:\/\//.test(href)) {
      window.open(href, '_blank', 'noopener,noreferrer');
    } else {
      onLinkClick?.(href);
    }
  }, [onLinkClick]);

  const handleOpenLink = useCallback((href: string) => {
    setLinkPopup(null);
    cancelHide();
    if (/^https?:\/\//.test(href)) {
      window.open(href, '_blank', 'noopener,noreferrer');
    } else {
      onLinkClick?.(href);
    }
  }, [onLinkClick, cancelHide]);

  const handleClosePopup = useCallback(() => {
    setLinkPopup(null);
    cancelHide();
  }, [cancelHide]);

  // Move from 'view' (hover) → 'edit' using the anchor DOM to resolve the doc range.
  const handleEditFromHover = useCallback(() => {
    setLinkPopup((current) => {
      if (!current || current.mode !== 'view') return current;
      const editor = editorRef.current;
      if (!editor) return current;
      let next: LinkPopupState | null = null;
      try {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const linkType = linkSchema.type(ctx);
          const pos = posForAnchor(view, current.anchor);
          if (pos == null) return;
          const range = findLinkRangeAtPos(view.state, linkType, pos);
          if (!range) return;
          next = {
            mode: 'edit',
            rect: current.anchor.getBoundingClientRect(),
            href: range.href,
            range: { from: range.from, to: range.to },
          };
        });
      } catch {
        return current;
      }
      return next ?? current;
    });
  }, []);

  const handleRemoveFromHover = useCallback(() => {
    const current = linkPopup;
    if (!current || current.mode !== 'view') return;
    const editor = editorRef.current;
    if (!editor) return;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const linkType = linkSchema.type(ctx);
        const pos = posForAnchor(view, current.anchor);
        if (pos == null) return;
        const range = findLinkRangeAtPos(view.state, linkType, pos);
        if (!range) return;
        view.dispatch(view.state.tr.removeMark(range.from, range.to, linkType));
      });
    } catch {
      // ignore
    }
    setLinkPopup(null);
  }, [linkPopup]);

  const handleApply = useCallback((href: string) => {
    const current = linkPopup;
    if (!current || current.mode === 'view') return;
    const editor = editorRef.current;
    if (!editor) return;
    const { range } = current;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const linkType = linkSchema.type(ctx);
        const tr = view.state.tr;
        tr.removeMark(range.from, range.to, linkType);
        if (href) tr.addMark(range.from, range.to, linkType.create({ href }));
        view.dispatch(tr);
      });
    } catch {
      // ignore
    }
    setLinkPopup(null);
  }, [linkPopup]);

  // Toolbar "Link" clicked — open in 'edit' (if cursor in a link) or 'new' (if selection non-empty).
  const handleRequestLink = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    let next: LinkPopupState | null = null;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;
        const linkType = linkSchema.type(ctx);
        const { from, to, empty } = state.selection;
        const existing = findLinkRangeAtPos(state, linkType, from);
        const makeRect = (a: number, b: number): DOMRect => {
          const start = view.coordsAtPos(a);
          const end = view.coordsAtPos(b);
          const left = Math.min(start.left, end.left);
          const top = Math.min(start.top, end.top);
          const right = Math.max(start.right, end.right);
          const bottom = Math.max(start.bottom, end.bottom);
          return new DOMRect(left, top, right - left, bottom - top);
        };
        if (existing) {
          next = {
            mode: 'edit',
            rect: makeRect(existing.from, existing.to),
            href: existing.href,
            range: { from: existing.from, to: existing.to },
          };
          return;
        }
        if (empty) return;
        next = {
          mode: 'new',
          rect: makeRect(from, to),
          href: '',
          range: { from, to },
        };
      });
    } catch {
      return;
    }
    if (next) setLinkPopup(next);
  }, []);

  return (
    <MilkdownProvider>
      <div className="flex h-full flex-col overflow-hidden">
        {!isReadOnly && (
          <MilkdownToolbar
            activeState={activeState}
            onRequestLink={handleRequestLink}
            rightSlot={toolbarRight}
          />
        )}
        <div
          className="min-h-0 flex-1 overflow-auto"
          onMouseOver={handleMouseOver}
          onMouseLeave={scheduleHide}
          onClickCapture={handleContainerClick}
        >
          <MilkdownEditorInner content={content} onChange={onChange} editorMode={editorMode} plugins={plugins} onActiveStateChange={setActiveState} onSelectionRectChange={setSelectionRect} editorRef={editorRef} onCursorLineChange={onCursorLineChange} initialLine={initialLine} direction={direction} />
        </div>
      </div>
      {!isReadOnly && !linkPopup && (
        <SelectionToolbar
          rect={selectionRect}
          activeState={activeState}
          onRequestLink={handleRequestLink}
        />
      )}
      {linkPopup && (
        <LinkPopup
          state={linkPopup}
          onOpen={handleOpenLink}
          onEdit={handleEditFromHover}
          onApply={handleApply}
          onRemove={handleRemoveFromHover}
          onClose={handleClosePopup}
          onMouseEnter={linkPopup.mode === 'view' ? cancelHide : undefined}
          onMouseLeave={linkPopup.mode === 'view' ? scheduleHide : undefined}
        />
      )}
    </MilkdownProvider>
  );
}
