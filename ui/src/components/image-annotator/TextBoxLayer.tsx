/**
 * The DOM overlay layer for text boxes, positioned over the canvas in display
 * coordinates. The layer is click-through; each box opts back into pointer
 * events only when the text tool is active (so pen/arrow can draw over text).
 */
import { cn } from '@src/lib/utils';
import { useLingui } from '@lingui/react/macro';
import type { TextBox } from './types';
import type { UseTextBoxes } from './use-text-boxes';

export interface TextBoxLayerProps {
  /** natural → display scale. */
  scale: number;
  /** Boxes are interactive only while the text tool is active. */
  interactive: boolean;
  boxes: TextBox[];
  editingId: number | null;
  selectedId: number | null;
  registerSpan: UseTextBoxes['registerSpan'];
  onSelect: (id: number) => void;
  onStartEdit: (id: number) => void;
  onBoxPointerDown: UseTextBoxes['onBoxPointerDown'];
  onInput: (id: number, text: string) => void;
  onCommit: (id: number) => void;
  onDelete: (id: number) => void;
}

export function TextBoxLayer({
  scale,
  interactive,
  boxes,
  editingId,
  selectedId,
  registerSpan,
  onSelect,
  onStartEdit,
  onBoxPointerDown,
  onInput,
  onCommit,
  onDelete,
}: TextBoxLayerProps) {
  const { t } = useLingui();

  return (
    <div className="pointer-events-none absolute inset-0">
      {boxes.map((b) => (
        <div
          key={b.id}
          className={cn('group absolute', interactive ? 'pointer-events-auto cursor-move' : 'pointer-events-none')}
          style={{ left: b.x * scale, top: b.y * scale }}
          onPointerDown={(e) => onBoxPointerDown(e, b)}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(b.id);
          }}
          onDoubleClick={() => onStartEdit(b.id)}
        >
          <span
            ref={registerSpan(b.id, b.text)}
            contentEditable={editingId === b.id}
            suppressContentEditableWarning
            onInput={(e) => onInput(b.id, e.currentTarget.textContent ?? '')}
            onBlur={() => onCommit(b.id)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') e.currentTarget.blur();
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            className={cn(
              'block min-w-[1ch] whitespace-pre font-semibold leading-tight outline-none',
              (selectedId === b.id || editingId === b.id) && 'ring-1 ring-blue-500',
              // Hint for an empty box (generated content — not part of textContent,
              // so it is never baked into the saved image).
              b.text === '' && "before:content-['Text'] before:opacity-40",
            )}
            style={{ color: b.color, fontSize: b.fontPx * scale, fontFamily: 'sans-serif' }}
          />
          <button
            type="button"
            title={t`Delete text`}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(b.id);
            }}
            className={cn(
              'absolute -right-2.5 -top-2.5 hidden h-[18px] w-[18px] items-center justify-center rounded-full bg-destructive text-[11px] leading-none text-destructive-foreground group-hover:flex',
              selectedId === b.id && 'flex',
            )}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
