/**
 * Simple WhatsApp-style image markup, shown BEFORE an image is attached/sent.
 * Freehand pen + arrow (baked into the canvas) plus PowerPoint-style text boxes
 * (live DOM overlays — add / click-to-edit / drag / × delete) flattened into the
 * canvas on Save. Save is disabled until the user marks up; closing while dirty
 * asks to discard. Output is a flattened PNG File (image/png so it passes the
 * fsService binary guard).
 *
 * Orchestrator only: the toolbar is AnnotatorToolbar, the text overlays are
 * TextBoxLayer (state in useTextBoxes), and canvas drawing lives in draw.ts.
 * This is a controlled component driven by the imperative `annotateImage()` host
 * in ./image-annotator-store; surfaces never mount it directly.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@src/components/ui/dialog';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { AnnotatorToolbar } from './AnnotatorToolbar';
import { TextBoxLayer } from './TextBoxLayer';
import { useTextBoxes } from './use-text-boxes';
import { bakeTextBoxes, drawScene } from './draw';
import { COLORS, toPngName, type Stroke, type Tool } from './types';

export interface ImageAnnotatorProps {
  open: boolean;
  /** The original image to annotate. */
  file: File | null;
  /** User saved: receives the flattened PNG File (image/png). */
  onSave: (annotated: File) => void;
  /**
   * Called synchronously within the Save click with a promise of the flattened
   * PNG, so a clipboard write keeps the user activation even though toBlob is
   * async (a slow toBlob on a large image would otherwise outlast the gesture
   * and the clipboard would silently keep the un-annotated original).
   */
  onClipboard: (blob: Promise<Blob>) => void;
  /** User dismissed without saving — capture is aborted (image dropped). */
  onCancel: () => void;
}

export function ImageAnnotator({ open, file, onSave, onClipboard, onCancel }: ImageAnnotatorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const drawingRef = useRef<Stroke | null>(null);

  const [color, setColor] = useState<string>(COLORS[0]);
  const [tool, setTool] = useState<Tool>('pen');
  const [strokeCount, setStrokeCount] = useState(0); // drives dirty + re-render
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // natural → display scale (canvas backing store vs CSS-rendered size).
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);
  scaleRef.current = scale;

  const text = useTextBoxes(scaleRef);
  const isDirty = strokeCount > 0 || text.hasContent;

  // Pen/arrow width and text size scale with image resolution.
  const penWidth = useCallback(() => {
    const img = imgRef.current;
    return img ? Math.max(3, Math.round(img.naturalWidth / 250)) : 4;
  }, []);
  const defaultFontPx = useCallback(() => {
    const img = imgRef.current;
    return img ? Math.max(16, Math.round(img.naturalWidth / 28)) : 28;
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !img || !ctx) return;
    drawScene(ctx, img, strokesRef.current, drawingRef.current);
  }, []);

  const measure = useCallback(() => {
    const c = canvasRef.current;
    if (!c || !c.width) return;
    const rect = c.getBoundingClientRect();
    if (rect.width) setScale(rect.width / c.width);
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
      text.reset();
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      measure();
      redraw();
    };
    img.src = url;
    return () => {
      cancelled = true;
      URL.revokeObjectURL(url);
      imgRef.current = null;
    };
    // text.reset is stable; intentionally excluded to avoid reload churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, file, redraw, measure]);

  // Keep `scale` current as the dialog/viewport resizes.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(c);
    measure();
    return () => ro.disconnect();
  }, [measure, open]);

  // Map a pointer event to canvas (image) coordinates, accounting for CSS scaling.
  const toCanvasPoint = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * canvas.width,
      y: ((clientY - rect.top) / rect.height) * canvas.height,
    };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!imgRef.current) return;
      if (tool === 'text') return; // text boxes are placed on click, not drag
      e.currentTarget.setPointerCapture(e.pointerId);
      const p = toCanvasPoint(e.clientX, e.clientY);
      // Arrow keeps just [start, end]; pen accumulates the freehand trail.
      drawingRef.current = { tool, color, width: penWidth(), points: [p, p] };
      redraw();
    },
    [color, penWidth, redraw, toCanvasPoint, tool],
  );

  // Text placement uses a discrete click (reliable across mouse/touch/pen),
  // rather than the pointerdown the drawing tools need.
  const onCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (tool !== 'text' || !imgRef.current) return;
      const p = toCanvasPoint(e.clientX, e.clientY);
      text.addTextBox(p.x, p.y, color, defaultFontPx());
    },
    [color, defaultFontPx, text, toCanvasPoint, tool],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const s = drawingRef.current;
      if (!s) return;
      const point = toCanvasPoint(e.clientX, e.clientY);
      if (s.tool === 'arrow') s.points[1] = point; // move the end point
      else s.points.push(point);
      redraw();
    },
    [redraw, toCanvasPoint],
  );

  const onPointerUp = useCallback(() => {
    const s = drawingRef.current;
    drawingRef.current = null;
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
    text.reset();
    redraw();
  }, [redraw, text]);

  const handlePickColor = useCallback(
    (c: string) => {
      setColor(c);
      text.recolorSelected(c); // recolor the selected text box, if any
    },
    [text],
  );

  const handleSave = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !file) return;
    redraw(); // base image + strokes
    bakeTextBoxes(ctx, text.textBoxes); // flatten text overlays into the canvas
    // One blob, two consumers: the clipboard write must be kicked off
    // synchronously here (still inside the Save click) so it keeps the user
    // activation; the upload happens once the blob resolves.
    const blobPromise = new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))), 'image/png');
    });
    onClipboard(blobPromise);
    blobPromise
      .then((blob) => onSave(new File([blob], toPngName(file.name), { type: 'image/png', lastModified: Date.now() })))
      .catch(() => {
        /* toBlob failure is rare; nothing to attach */
      });
  }, [file, onClipboard, onSave, redraw, text.textBoxes]);

  const requestClose = useCallback(() => {
    if (isDirty) {
      setConfirmDiscard(true);
      return;
    }
    onCancel();
  }, [isDirty, onCancel]);

  // Enter saves (Esc cancels). Document-level so it works regardless of which
  // control is focused; skipped while editing a text box (there Enter commits
  // the text, Shift+Enter adds a line). stopPropagation so a focused button
  // doesn't also activate.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.shiftKey || text.editingId != null || !isDirty) return;
      e.preventDefault();
      e.stopPropagation();
      handleSave();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, text.editingId, isDirty, handleSave]);

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
            Draw with the pen or arrow, add text boxes, then Save to attach the annotated copy.
          </DialogDescription>

          <AnnotatorToolbar
            tool={tool}
            onToolChange={setTool}
            color={color}
            onColorPick={handlePickColor}
            canUndo={strokeCount > 0}
            onUndo={handleUndo}
            isDirty={isDirty}
            onClear={handleClear}
            onCancel={requestClose}
            onSave={handleSave}
          />

          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-md bg-muted/30">
            <div className="relative">
              <canvas
                ref={canvasRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={onPointerUp}
                onClick={onCanvasClick}
                className="block max-h-[78vh] max-w-full touch-none"
                style={{ cursor: tool === 'text' ? 'text' : 'crosshair' }}
              />
              <TextBoxLayer
                scale={scale}
                interactive={tool === 'text'}
                boxes={text.textBoxes}
                editingId={text.editingId}
                selectedId={text.selectedId}
                registerSpan={text.registerSpan}
                onSelect={text.select}
                onStartEdit={text.startEdit}
                onBoxPointerDown={text.onBoxPointerDown}
                onInput={text.updateText}
                onCommit={text.commitText}
                onDelete={text.deleteText}
              />
            </div>
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
