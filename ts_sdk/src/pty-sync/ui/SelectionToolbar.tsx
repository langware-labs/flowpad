import { useState, useRef, useEffect } from 'react';
import type { SelectionContext, XtermToolbar, ToolbarButton } from './XtermToolbar.js';
import type { LiveXtermAdapter } from '../adapter/XtermAdapter.js';

const TOOLBAR_HEIGHT = 32;

// ─── SelectionToolbar ─────────────────────────────────────────────────────────

interface Props {
  ctx:       SelectionContext;
  toolbar:   XtermToolbar;
  adapter:   LiveXtermAdapter;
  onDismiss: () => void;
}

export function SelectionToolbar({ ctx, toolbar, adapter, onDismiss }: Props) {
  const [commentMode, setCommentMode] = useState(false);
  const [commentText, setCommentText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (commentMode) inputRef.current?.focus();
  }, [commentMode]);

  const { cellWidth } = adapter.getDimensions();
  const pixelY = adapter.bufferIndexToPixelY(ctx.startRow);
  const left   = ctx.startColumn * cellWidth;
  const top    = Math.max(0, pixelY - TOOLBAR_HEIGHT);

  function handleButtonClick(button: ToolbarButton) {
    if (button.id === 'selectionComment') {
      setCommentMode(true);
    } else {
      button.handler(ctx);
      onDismiss();
    }
  }

  function commitComment() {
    const btn = toolbar.buttons.find(b => b.id === 'selectionComment');
    if (btn) btn.handler({ ...ctx, text: commentText });
    onDismiss();
  }

  return (
    <div
      data-testid="selection-toolbar"
      style={{
        position:   'absolute',
        left,
        top,
        display:    'flex',
        alignItems: 'center',
        gap:        4,
        background: '#161b22',
        border:     '1px solid #30363d',
        borderRadius: 8,
        padding:    '4px 8px',
        zIndex:     100,
        height:     TOOLBAR_HEIGHT,
        boxSizing:  'border-box',
        whiteSpace: 'nowrap',
      }}
    >
      {commentMode ? (
        <input
          ref={inputRef}
          value={commentText}
          onChange={e => setCommentText(e.target.value)}
          placeholder="Add comment…"
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commitComment(); }
            if (e.key === 'Escape') onDismiss();
          }}
          onBlur={commitComment}
          style={{
            background:   '#21262d',
            color:        '#c9d1d9',
            border:       '1px solid #388bfd',
            borderRadius: 4,
            padding:      '2px 6px',
            fontSize:     12,
            outline:      'none',
            width:        160,
          }}
        />
      ) : (
        toolbar.buttons.map(button => (
          <button
            key={button.id}
            data-testid={`toolbar-btn-${button.id}`}
            onMouseDown={e => e.preventDefault()}
            onClick={() => handleButtonClick(button)}
            style={{
              background:   'transparent',
              color:        '#c9d1d9',
              border:       '1px solid #30363d',
              borderRadius: 4,
              padding:      '2px 8px',
              fontSize:     11,
              cursor:       'pointer',
              fontWeight:   500,
            }}
          >
            {button.label}
          </button>
        ))
      )}
    </div>
  );
}
