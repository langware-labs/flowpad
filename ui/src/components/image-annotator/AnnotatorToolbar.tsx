/** The top toolbar: tool toggle, color swatches, undo/clear, cancel/save. */
import { ArrowUpRight, Check, Eraser, Pen, Type, Undo2, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { cn } from '@src/lib/utils';
import { COLORS, type Tool } from './types';

const TOOLS = [
  ['pen', Pen, 'Pen'],
  ['arrow', ArrowUpRight, 'Arrow'],
  ['text', Type, 'Text'],
] as const;

const ICON_BTN =
  'flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40';

export interface AnnotatorToolbarProps {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  color: string;
  onColorPick: (color: string) => void;
  canUndo: boolean;
  onUndo: () => void;
  isDirty: boolean;
  onClear: () => void;
  onCancel: () => void;
  onSave: () => void;
}

export function AnnotatorToolbar({
  tool,
  onToolChange,
  color,
  onColorPick,
  canUndo,
  onUndo,
  isDirty,
  onClear,
  onCancel,
  onSave,
}: AnnotatorToolbarProps) {
  const { t } = useLingui();

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-0.5">
        {TOOLS.map(([t, Icon, label]) => (
          <button
            key={t}
            type="button"
            title={label}
            onClick={() => onToolChange(t)}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
              tool === t
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>
      <div className="mx-1 h-6 w-px bg-border" />
      <div className="flex items-center gap-1">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            onClick={() => onColorPick(c)}
            className={cn(
              'h-6 w-6 rounded-full border transition-transform',
              color === c ? 'scale-110 border-foreground ring-2 ring-foreground/30' : 'border-border',
            )}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
      <div className="mx-1 h-6 w-px bg-border" />
      <button type="button" title={t`Undo`} onClick={onUndo} disabled={!canUndo} className={ICON_BTN}>
        <Undo2 className="h-4 w-4" />
      </button>
      <button type="button" title={t`Clear`} onClick={onClear} disabled={!isDirty} className={ICON_BTN}>
        <Eraser className="h-4 w-4" />
      </button>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex h-8 items-center gap-1 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
          <Trans>Cancel</Trans>
        </button>
        <button
          type="button"
          onClick={onSave}
          className="flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
        >
          <Check className="h-4 w-4" />
          {isDirty ? <Trans>Save</Trans> : <Trans>Attach</Trans>}
        </button>
      </div>
    </div>
  );
}
