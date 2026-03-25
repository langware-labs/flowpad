import { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { StreamMetrics } from '../scroll/StreamMetrics.js';

const COL_WIDTH = 32;
const SQ_SIZE   = 10;

interface Props {
  metrics: StreamMetrics;
  /** Map<bufferRow, commentText> — read by CommentCol and StreamMapCanvas */
  comments: Map<number, string>;
  onCommentChange: (bufferRow: number, text: string) => void;
}

/**
 * Comment column — aligns with xterm viewport line-by-line and scrolls with it.
 *
 * Each row = one buffer row in the current viewport. A small colored square
 * indicates a comment exists for that row. Click → inline textarea to edit.
 *
 * Primary sync key: bufferRow (maps directly to xterm viewport rows).
 */
export function CommentCol({ metrics, comments, onCommentChange }: Props) {
  const { firstVisibleRow, evictionOffset, visibleRows, cellHeight, viewportPixelHeight } = metrics;
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [popupRect, setPopupRect] = useState<{ top: number; right: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus the textarea after React commits the DOM — more reliable than rAF
  useEffect(() => {
    if (editingRow !== null) textareaRef.current?.focus();
  }, [editingRow]);

  // Use VT-absolute row keys so comments survive xterm eviction offset changes.
  const rows = Array.from({ length: visibleRows }, (_, i) => firstVisibleRow + evictionOffset + i);

  function openEdit(bufferRow: number, el: HTMLDivElement) {
    const rect = el.getBoundingClientRect();
    setPopupRect({ top: rect.top, right: rect.right });
    setEditingRow(bufferRow);
  }

  function commitEdit(bufferRow: number, text: string) {
    onCommentChange(bufferRow, text);
    setEditingRow(null);
    setPopupRect(null);
  }

  return (
    <>
      <div
        data-testid="comment-col"
        style={{
          width:    COL_WIDTH,
          height:   viewportPixelHeight,
          flexShrink: 0,
          overflow: 'hidden',
          position: 'relative',
          display:  'flex',
          flexDirection: 'column',
        }}
      >
        {rows.map(bufferRow => {
          const comment = comments.get(bufferRow);

          return (
            <div
              key={bufferRow}
              data-testid="comment-row"
              data-buffer-row={bufferRow}
              title={comment ?? 'Click to add comment'}
              style={{
                height:     cellHeight,
                flexShrink: 0,
                display:    'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor:     'pointer',
              }}
              onClick={e => openEdit(bufferRow, e.currentTarget)}
            >
              <div
                data-testid={comment ? 'comment-square' : undefined}
                style={{
                  width:        SQ_SIZE,
                  height:       SQ_SIZE,
                  borderRadius: 2,
                  background:   comment ? '#f0a050' : '#2a3140',
                  border:       comment ? '1px solid #f0a050aa' : '1px solid #3a4555',
                  transition:   'background 0.1s',
                }}
              />
            </div>
          );
        })}
      </div>

      {/* Comment edit popup — rendered in a portal so it floats above all panels */}
      {editingRow !== null && popupRect && createPortal(
        <textarea
          ref={textareaRef}
          defaultValue={comments.get(editingRow) ?? ''}
          placeholder="Add comment…"
          onBlur={e => commitEdit(editingRow, e.target.value.trim())}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commitEdit(editingRow, (e.target as HTMLTextAreaElement).value.trim());
            }
            if (e.key === 'Escape') { setEditingRow(null); setPopupRect(null); }
          }}
          style={{
            position:     'fixed',
            left:         popupRect.right + 6,
            top:          popupRect.top,
            zIndex:       9999,
            width:        220,
            height:       90,
            background:   '#1c2128',
            color:        '#c9d1d9',
            border:       '1px solid #388bfd',
            borderRadius: 6,
            padding:      8,
            fontSize:     12,
            resize:       'both',
            fontFamily:   'monospace',
            boxShadow:    '0 4px 20px rgba(0,0,0,0.6)',
            outline:      'none',
          }}
        />,
        document.body,
      )}
    </>
  );
}
