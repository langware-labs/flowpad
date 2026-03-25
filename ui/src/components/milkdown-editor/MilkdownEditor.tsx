import { Editor, rootCtx, defaultValueCtx } from '@milkdown/core';
import { Milkdown, MilkdownProvider, useEditor, useInstance } from '@milkdown/react';
import {
  commonmark,
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  createCodeBlockCommand,
} from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { prism } from '@milkdown/plugin-prism';
import { emoji } from '@milkdown/plugin-emoji';
import { callCommand } from '@milkdown/utils';
import type { MilkdownPlugin } from '@milkdown/ctx';
import type { Ctx } from '@milkdown/ctx';
import {
  Bold, Italic, Code, Heading1, Heading2, Heading3,
  List, ListOrdered, SquareCode,
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
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function MilkdownToolbar() {
  const [loading, get] = useInstance();

  const act = useCallback(
    (fn: (ctx: Ctx) => void) => {
      if (loading) return;
      get().action(fn);
    },
    [loading, get],
  );

  const btn = (title: string, icon: React.ReactNode, fn: (ctx: Ctx) => void) => (
    <button
      title={title}
      onMouseDown={(e) => { e.preventDefault(); act(fn); }}
      className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {icon}
    </button>
  );

  return (
    <div className="flex flex-shrink-0 items-center gap-0.5 border-b bg-muted/20 px-2 py-1">
      {btn('Bold', <Bold className="h-3.5 w-3.5" />, callCommand(toggleStrongCommand.key))}
      {btn('Italic', <Italic className="h-3.5 w-3.5" />, callCommand(toggleEmphasisCommand.key))}
      {btn('Inline code', <Code className="h-3.5 w-3.5" />, callCommand(toggleInlineCodeCommand.key))}
      <div className="mx-1.5 h-4 w-px bg-border" />
      {btn('Heading 1', <Heading1 className="h-3.5 w-3.5" />, callCommand(wrapInHeadingCommand.key, 1))}
      {btn('Heading 2', <Heading2 className="h-3.5 w-3.5" />, callCommand(wrapInHeadingCommand.key, 2))}
      {btn('Heading 3', <Heading3 className="h-3.5 w-3.5" />, callCommand(wrapInHeadingCommand.key, 3))}
      <div className="mx-1.5 h-4 w-px bg-border" />
      {btn('Bullet list', <List className="h-3.5 w-3.5" />, callCommand(wrapInBulletListCommand.key))}
      {btn('Ordered list', <ListOrdered className="h-3.5 w-3.5" />, callCommand(wrapInOrderedListCommand.key))}
      {btn('Code block', <SquareCode className="h-3.5 w-3.5" />, callCommand(createCodeBlockCommand.key))}
    </div>
  );
}

// ── Editor inner ──────────────────────────────────────────────────────────────

function MilkdownEditorInner({ content, onChange, readOnly, plugins }: MilkdownEditorProps) {
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
          if (onChange) {
            ctx.get(listenerCtx).markdownUpdated((_, markdown) => {
              onChange(markdown);
            });
          }
        })
        .use(commonmark)
        .use(gfm)
        .use(listener)
        .use(prism)
        .use(emoji);

      // Register extra plugins (e.g. plan-note mark)
      if (plugins) {
        for (const plugin of plugins) {
          editor.use(plugin);
        }
      }

      return editor;
    },
    [onChange, plugins],
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

export function MilkdownEditor({ content, onChange, readOnly, plugins }: MilkdownEditorProps) {
  return (
    <MilkdownProvider>
      <div className="flex h-full flex-col overflow-hidden">
        {!readOnly && <MilkdownToolbar />}
        <div className="min-h-0 flex-1 overflow-auto">
          <MilkdownEditorInner content={content} onChange={onChange} readOnly={readOnly} plugins={plugins} />
        </div>
      </div>
    </MilkdownProvider>
  );
}
