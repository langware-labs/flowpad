import { Editor, rootCtx, defaultValueCtx, editorViewCtx, parserCtx } from '@milkdown/core';
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
import { gfm } from '@milkdown/preset-gfm';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { prism } from '@milkdown/plugin-prism';
import { emoji } from '@milkdown/plugin-emoji';
import { history } from '@milkdown/plugin-history';
import { trailing } from '@milkdown/plugin-trailing';
import { callCommand } from '@milkdown/utils';
import type { MilkdownPlugin } from '@milkdown/ctx';
import type { Ctx } from '@milkdown/ctx';
import type { EditorState } from '@milkdown/prose/state';
import type { MarkType } from '@milkdown/prose/model';
import type { EditorView } from '@milkdown/prose/view';
import {
  Bold, Italic, Code, Heading1, Heading2, Heading3,
  List, ListOrdered, SquareCode, Pilcrow, ExternalLink,
  Link as LinkIcon, Check, X, Pencil, Unlink,
} from 'lucide-react';

// Prism core must be imported before language components
import 'prismjs';
// Prism languages
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';

import './milkdown.css';

/**
 * Strip HTML comments from markdown content for display.
 * Comments like <!-- ... --> are hidden in WYSIWYG mode.
 */
function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '');
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
            title="Apply"
            className="flex items-center rounded px-1 py-0.5 text-xs hover:bg-muted"
            data-testid="milkdown-link-apply"
          >
            <Check className="h-3 w-3" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); onClose(); }}
            title="Cancel"
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
            title="Open link"
          >
            <ExternalLink className="h-3 w-3" />
            Open
          </button>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onEdit(); }}
            className="flex items-center rounded px-1 py-0.5 text-xs hover:bg-muted"
            title="Edit link"
            data-testid="milkdown-link-edit"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}
            className="flex items-center rounded px-1 py-0.5 text-xs hover:bg-muted"
            title="Remove link"
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
}

const EMPTY_ACTIVE: ActiveState = {
  bold: false, italic: false, inlineCode: false,
  headingLevel: 0, bulletList: false, orderedList: false, codeBlock: false,
  link: false, canAddLink: false,
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

  return { bold, italic, inlineCode, headingLevel, bulletList, orderedList, codeBlock, link, canAddLink };
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function MilkdownToolbar({
  activeState,
  onRequestLink,
}: {
  activeState: ActiveState;
  onRequestLink: () => void;
}) {
  const [loading, get] = useInstance();

  const act = useCallback(
    (fn: (ctx: Ctx) => void) => {
      if (loading) return;
      get().action(fn);
    },
    [loading, get],
  );

  const btn = (title: string, icon: React.ReactNode, fn: (ctx: Ctx) => void, active = false) => (
    <button
      title={title}
      onMouseDown={(e) => { e.preventDefault(); act(fn); }}
      className={`flex h-7 w-7 items-center justify-center rounded hover:bg-muted hover:text-foreground ${
        active
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground'
      }`}
    >
      {icon}
    </button>
  );

  const { bold, italic, inlineCode, headingLevel, bulletList, orderedList, codeBlock, link, canAddLink } = activeState;
  const linkEnabled = link || canAddLink;

  return (
    <div className="flex flex-shrink-0 items-center gap-0.5 border-b bg-muted/20 px-2 py-1">
      {btn('Bold', <Bold className="h-3.5 w-3.5" />, callCommand(toggleStrongCommand.key), bold)}
      {btn('Italic', <Italic className="h-3.5 w-3.5" />, callCommand(toggleEmphasisCommand.key), italic)}
      {btn('Inline code', <Code className="h-3.5 w-3.5" />, callCommand(toggleInlineCodeCommand.key), inlineCode)}
      <button
        title={link ? 'Edit link' : canAddLink ? 'Add link' : 'Select text to add a link'}
        disabled={!linkEnabled}
        onMouseDown={(e) => { e.preventDefault(); if (linkEnabled) onRequestLink(); }}
        data-testid="milkdown-toolbar-link"
        className={`flex h-7 w-7 items-center justify-center rounded hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground ${
          link ? 'bg-muted text-foreground' : 'text-muted-foreground'
        }`}
      >
        <LinkIcon className="h-3.5 w-3.5" />
      </button>
      <div className="mx-1.5 h-4 w-px bg-border" />
      {btn('Normal text', <Pilcrow className="h-3.5 w-3.5" />, callCommand(turnIntoTextCommand.key), headingLevel === 0 && !codeBlock)}
      {btn('Heading 1', <Heading1 className="h-3.5 w-3.5" />, callCommand(wrapInHeadingCommand.key, 1), headingLevel === 1)}
      {btn('Heading 2', <Heading2 className="h-3.5 w-3.5" />, callCommand(wrapInHeadingCommand.key, 2), headingLevel === 2)}
      {btn('Heading 3', <Heading3 className="h-3.5 w-3.5" />, callCommand(wrapInHeadingCommand.key, 3), headingLevel === 3)}
      <div className="mx-1.5 h-4 w-px bg-border" />
      {btn('Bullet list', <List className="h-3.5 w-3.5" />, callCommand(wrapInBulletListCommand.key), bulletList)}
      {btn('Ordered list', <ListOrdered className="h-3.5 w-3.5" />, callCommand(wrapInOrderedListCommand.key), orderedList)}
      {btn('Code block', <SquareCode className="h-3.5 w-3.5" />, callCommand(createCodeBlockCommand.key), codeBlock)}
    </div>
  );
}

// ── Editor inner ──────────────────────────────────────────────────────────────

function MilkdownEditorInner({ content, onChange, editorMode, plugins, onActiveStateChange, editorRef }: MilkdownEditorProps & { onActiveStateChange?: (s: ActiveState) => void; editorRef?: React.MutableRefObject<Editor | null> }) {
  const isReadOnly = editorMode === 'view' || editorMode === 'review';
  const localRef = useRef<Editor | null>(null);
  const setEditor = (e: Editor | null) => {
    localRef.current = e;
    if (editorRef) editorRef.current = e;
  };

  // Strip HTML comments for display in WYSIWYG mode
  const displayContent = useMemo(() => stripHtmlComments(content), [content]);
  const initialContentRef = useRef(displayContent);
  // Track the last markdown we emitted via onChange so we can tell user edits
  // apart from external content changes (e.g. file rewritten on disk).
  const lastEmittedRef = useRef(displayContent);

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
          const lctx = ctx.get(listenerCtx);
          if (onChange) {
            lctx.markdownUpdated((_, markdown) => {
              lastEmittedRef.current = markdown;
              onChange(markdown);
            });
          }
          if (onActiveStateChange) {
            const notify = (ctx: Ctx) => {
              try {
                onActiveStateChange(getActiveState(ctx.get(editorViewCtx).state));
              } catch {
                // view not ready during initialization
              }
            };
            // Fire on document changes — debounced 200ms so view.state is already updated
            lctx.updated((ctx) => notify(ctx));
            // selectionUpdated fires synchronously during apply (view.state is still old),
            // so defer by one tick to read the updated view.state
            lctx.selectionUpdated((ctx) => setTimeout(() => notify(ctx), 0));
          }
        })
        .use(commonmark)
        .use(gfm)
        .use(listener)
        .use(prism)
        .use(emoji)
        .use(history)
        .use(trailing);

      // Register extra plugins (e.g. plan-note mark)
      if (plugins) {
        for (const plugin of plugins) {
          editor.use(plugin);
        }
      }

      return editor;
    },
    [onChange, onActiveStateChange, plugins],
  );

  useEffect(() => {
    if (get) {
      setEditor(get() ?? null);
    }
  }, [get]);

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
    <div className={`milkdown-editor-wrapper h-full ${isReadOnly ? 'pointer-events-none opacity-80' : ''}`}>
      <Milkdown />
    </div>
  );
}

export function MilkdownEditor({ content, onChange, editorMode = 'editor', plugins, onLinkClick }: MilkdownEditorProps) {
  const isReadOnly = editorMode === 'view' || editorMode === 'review';
  const [activeState, setActiveState] = useState<ActiveState>(EMPTY_ACTIVE);
  const [linkPopup, setLinkPopup] = useState<LinkPopupState | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);

  useEffect(() => () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); }, []);

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
  }, [cancelHide, scheduleHide]);

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
        {!isReadOnly && <MilkdownToolbar activeState={activeState} onRequestLink={handleRequestLink} />}
        <div
          className="min-h-0 flex-1 overflow-auto"
          onMouseOver={handleMouseOver}
          onMouseLeave={scheduleHide}
        >
          <MilkdownEditorInner content={content} onChange={onChange} editorMode={editorMode} plugins={plugins} onActiveStateChange={setActiveState} editorRef={editorRef} />
        </div>
      </div>
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
