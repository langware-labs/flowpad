/**
 * Simple WhatsApp-style image markup, shown BEFORE an image is attached/sent.
 * Freehand pen + arrow over a <canvas> rendering of the image — a few colors +
 * undo/clear. Save is disabled until the user actually draws; closing while
 * dirty asks to discard. Output is a flattened PNG File (image/png MIME so it
 * passes the fsService binary-upload guard).
 *
 * This is a controlled component. The imperative `annotateImage()` host in
 * ./image-annotator-store drives it; surfaces never mount it directly.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Eraser, Pen, Undo2, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@src/components/ui/dialog';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { cn } from '@src/lib/utils';

const COLORS = ['#ef4444', '#eab308', '#22c55e', '#3b82f6', '#111827', '#ffffff'] as const;

type Tool = 'pen' | 'arrow';

interface Point {
  x: number;
  y: number;
}
interface Stroke {
  tool: Tool;
  color: string;
  width: number;
  points: Point[];
}

export interface ImageAnnotatorProps {
  open: boolean;
  /** The original image to annotate. */
  file: File | null;
  /** User saved: receives the flattened PNG File (image/png). */
  onSave: (annotated: File) => void;
  /** User dismissed without saving — original should pass through unchanged. */
  onCancel: () => void;
}

/** Force a `.png` extension — a re-encoded JPEG/GIF must not keep a misleading name. */
function toPngName(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '');
  return `${base || 'image'}.png`;
}

export function ImageAnnotator({ open, file, onSave, onCancel }: ImageAnnotatorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const drawingRef = useRef<Stroke | null>(null);

  const [color, setColor] = useState<string>(COLORS[0]);
  const [tool, setTool] = useState<Tool>('pen');
  const [strokeCount, setStrokeCount] = useState(0); // drives dirty + re-render of toolbar
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const isDirty = strokeCount > 0;

  // Pen width scales with image resolution so it reads the same regardless of size.
  const penWidth = useCallback(() => {
    const img = imgRef.current;
    return img ? Math.max(3, Math.round(img.naturalWidth / 250)) : 4;
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const drawStroke = (s: Stroke) => {
      if (s.points.length === 0) return;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      if (s.tool === 'arrow') {
        // Straight shaft from first to last point, plus a two-line arrowhead.
        const from = s.points[0];
        const to = s.points[s.points.length - 1];
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        const head = s.width * 6; // arrowhead length scales with line width (~150% of the base size)
        for (const offset of [Math.PI * 0.85, -Math.PI * 0.85]) {
          ctx.beginPath();
          ctx.moveTo(to.x, to.y);
          ctx.lineTo(to.x + head * Math.cos(angle + offset), to.y + head * Math.sin(angle + offset));
          ctx.stroke();
        }
        return;
      }
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
      ctx.stroke();
    };
    // Iterate the committed strokes in place, then the in-progress one — no
    // per-frame array allocation (redraw runs on every pointer move).
    for (const s of strokesRef.current) drawStroke(s);
    if (drawingRef.current) drawStroke(drawingRef.current);
  }, []);

  // (Re)load the image whenever a new file is opened. Reset all annotation state.
  useEffect(() => {
    if (!open || !file) return;
    let cancelled = false;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      strokesRef.current = [];
      drawingRef.current = null;
      setStrokeCount(0);
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      redraw();
    };
    img.src = url;
    return () => {
      cancelled = true;
      URL.revokeObjectURL(url);
      imgRef.current = null;
    };
  }, [open, file, redraw]);

  // Map a pointer event to canvas (image) coordinates, accounting for CSS scaling.
  const toCanvasPoint = useCallback((e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!imgRef.current) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const start = toCanvasPoint(e);
      // Arrow keeps just [start, end]; pen accumulates the freehand trail.
      drawingRef.current = { tool, color, width: penWidth(), points: [start, start] };
      redraw();
    },
    [color, penWidth, redraw, toCanvasPoint, tool],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const s = drawingRef.current;
      if (!s) return;
      const point = toCanvasPoint(e);
      if (s.tool === 'arrow') s.points[1] = point; // move the end point
      else s.points.push(point);
      redraw();
    },
    [redraw, toCanvasPoint],
  );

  const onPointerUp = useCallback(() => {
    const s = drawingRef.current;
    drawingRef.current = null;
    // Drop a degenerate arrow (a tap with no drag — start === end).
    const isDegenerateArrow =
      s?.tool === 'arrow' && s.points[0].x === s.points[1].x && s.points[0].y === s.points[1].y;
    if (s && s.points.length > 0 && !isDegenerateArrow) {
      strokesRef.current.push(s);
      setStrokeCount(strokesRef.current.length);
    }
    redraw();
  }, [redraw]);

  const handleUndo = useCallback(() => {
    strokesRef.current.pop();
    setStrokeCount(strokesRef.current.length);
    redraw();
  }, [redraw]);

  const handleClear = useCallback(() => {
    strokesRef.current = [];
    setStrokeCount(0);
    redraw();
  }, [redraw]);

  const handleSave = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !file) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const annotated = new File([blob], toPngName(file.name), {
        type: 'image/png',
        lastModified: Date.now(),
      });
      onSave(annotated);
    }, 'image/png');
  }, [file, onSave]);

  // Close requested (Esc / overlay / X / Cancel). Guard when there are edits.
  const requestClose = useCallback(() => {
    if (isDirty) {
      setConfirmDiscard(true);
      return;
    }
    onCancel();
  }, [isDirty, onCancel]);

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && requestClose()}>
        <DialogContent
          className="flex max-h-[92vh] w-auto max-w-[92vw] flex-col gap-3 p-3"
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            requestClose();
          }}
        >
          <DialogTitle className="sr-only">Annotate image</DialogTitle>
          <DialogDescription className="sr-only">
            Draw on the image with the pen or arrow, then Save to attach the annotated copy.
          </DialogDescription>
          {/* Toolbar on top, WhatsApp-style. */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5">
              {([['pen', Pen, 'Pen'], ['arrow', ArrowUpRight, 'Arrow']] as const).map(([t, Icon, label]) => (
                <button
                  key={t}
                  type="button"
                  title={label}
                  onClick={() => setTool(t)}
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
                  onClick={() => setColor(c)}
                  className={cn(
                    'h-6 w-6 rounded-full border transition-transform',
                    color === c ? 'scale-110 border-foreground ring-2 ring-foreground/30' : 'border-border',
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <div className="mx-1 h-6 w-px bg-border" />
            <button
              type="button"
              title="Undo"
              onClick={handleUndo}
              disabled={!isDirty}
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <Undo2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="Clear"
              onClick={handleClear}
              disabled={!isDirty}
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <Eraser className="h-4 w-4" />
            </button>

            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={requestClose}
                className="flex h-8 items-center gap-1 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!isDirty}
                className="flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
              >
                <Check className="h-4 w-4" />
                Save
              </button>
            </div>
          </div>

          {/* Canvas — backing store at natural res, scaled to fit via CSS. */}
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-md bg-muted/30">
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
              className="max-h-[78vh] max-w-full touch-none"
              style={{ cursor: 'crosshair', objectFit: 'contain' }}
            />
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard changes?"
        description="Your markup on this image will be lost."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        variant="destructive"
        onConfirm={onCancel}
      />
    </>
  );
}
