import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/core';
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
import {
  Bold, Italic, Code, Heading1, Heading2, Heading3,
  List, ListOrdered, SquareCode, Pilcrow, ExternalLink,
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

interface MilkdownEditorProps {
  content: string;
  onChange?: (content: string) => void;
  readOnly?: boolean;
  plugins?: MilkdownPlugin[];
  onLinkClick?: (href: string) => void;
}

// ── Link hover toolbar ────────────────────────────────────────────────────────

interface HoveredLink {
  href: string;
  rect: DOMRect;
}

function LinkHoverToolbar({
  link,
  onOpen,
  onMouseEnter,
  onMouseLeave,
}: {
  link: HoveredLink;
  onOpen: (href: string) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const { href, rect } = link;
  const showAbove = rect.top > 56;
  const left = Math.min(rect.left, window.innerWidth - 260);

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
    >
      <span className="max-w-[180px] truncate text-xs text-muted-foreground">{href}</span>
      <div className="h-3.5 w-px bg-border" />
      <button
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onOpen(href); }}
        className="flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium hover:bg-muted"
      >
        <ExternalLink className="h-3 w-3" />
        Open
      </button>
    </div>
  );
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
}

const EMPTY_ACTIVE: ActiveState = {
  bold: false, italic: false, inlineCode: false,
  headingLevel: 0, bulletList: false, orderedList: false, codeBlock: false,
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

  return { bold, italic, inlineCode, headingLevel, bulletList, orderedList, codeBlock };
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function MilkdownToolbar({ activeState }: { activeState: ActiveState }) {
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

  const { bold, italic, inlineCode, headingLevel, bulletList, orderedList, codeBlock } = activeState;

  return (
    <div className="flex flex-shrink-0 items-center gap-0.5 border-b bg-muted/20 px-2 py-1">
      {btn('Bold', <Bold className="h-3.5 w-3.5" />, callCommand(toggleStrongCommand.key), bold)}
      {btn('Italic', <Italic className="h-3.5 w-3.5" />, callCommand(toggleEmphasisCommand.key), italic)}
      {btn('Inline code', <Code className="h-3.5 w-3.5" />, callCommand(toggleInlineCodeCommand.key), inlineCode)}
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

function MilkdownEditorInner({ content, onChange, readOnly, plugins, onActiveStateChange }: MilkdownEditorProps & { onActiveStateChange?: (s: ActiveState) => void }) {
  const editorRef = useRef<Editor | null>(null);

  // Strip HTML comments for display in WYSIWYG mode
  const displayContent = useMemo(() => stripHtmlComments(content), [content]);
  const initialContentRef = useRef(displayContent);

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
            lctx.markdownUpdated((_, markdown) => { onChange(markdown); });
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
      editorRef.current = get() ?? null;
    }
  }, [get]);

  return (
    <div className={`milkdown-editor-wrapper h-full ${readOnly ? 'pointer-events-none opacity-80' : ''}`}>
      <Milkdown />
    </div>
  );
}

export function MilkdownEditor({ content, onChange, readOnly, plugins, onLinkClick }: MilkdownEditorProps) {
  const [activeState, setActiveState] = useState<ActiveState>(EMPTY_ACTIVE);
  const [hoveredLink, setHoveredLink] = useState<HoveredLink | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); }, []);

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
  }, []);

  const scheduleHide = useCallback(() => {
    cancelHide();
    hideTimerRef.current = setTimeout(() => setHoveredLink(null), 300);
  }, [cancelHide]);

  const handleMouseOver = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (anchor) {
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      cancelHide();
      setHoveredLink({ href, rect: anchor.getBoundingClientRect() });
    } else {
      scheduleHide();
    }
  }, [cancelHide, scheduleHide]);

  const handleOpenLink = useCallback((href: string) => {
    setHoveredLink(null);
    cancelHide();
    if (/^https?:\/\//.test(href)) {
      window.open(href, '_blank', 'noopener,noreferrer');
    } else {
      onLinkClick?.(href);
    }
  }, [onLinkClick, cancelHide]);

  return (
    <MilkdownProvider>
      <div className="flex h-full flex-col overflow-hidden">
        {!readOnly && <MilkdownToolbar activeState={activeState} />}
        <div
          className="min-h-0 flex-1 overflow-auto"
          onMouseOver={handleMouseOver}
          onMouseLeave={scheduleHide}
        >
          <MilkdownEditorInner content={content} onChange={onChange} readOnly={readOnly} plugins={plugins} onActiveStateChange={setActiveState} />
        </div>
      </div>
      {hoveredLink && (
        <LinkHoverToolbar
          link={hoveredLink}
          onOpen={handleOpenLink}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
        />
      )}
    </MilkdownProvider>
  );
}
