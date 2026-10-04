/**
 * Simple WhatsApp-style image markup, shown BEFORE an image is attached/sent.
 * Freehand pen + arrow (baked into the canvas) plus PowerPoint-style text boxes
 * (live DOM overlays — add / click-to-edit / drag / × delete) flattened into the
 * canvas on Save. Closing while dirty asks to discard. Output is a flattened PNG
 * File (image/png so it passes the fsService binary guard).
 *
 * Under the image sits a caption box, focused on open, so a paste can be followed
 * straight by a note: type or paste, Enter delivers image + caption, Shift+Enter
 * is a newline. Starting to draw takes focus off the caption, after which the
 * keys behave as they do without it. Text drawn ON the image never feeds the caption.
 *
 * Orchestrator only: the toolbar is AnnotatorToolbar, the text overlays are
 * TextBoxLayer (state in useTextBoxes), and canvas drawing lives in draw.ts.
 * This is a controlled component driven by the imperative `annotateImage()` host
 * in ./image-annotator-store; surfaces never mount it directly.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@src/components/ui/dialog';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { AnnotatorToolbar } from './AnnotatorToolbar';
import { TextBoxLayer } from './TextBoxLayer';
import { useTextBoxes } from './use-text-boxes';
import { bakeTextBoxes, drawScene } from './draw';
import { clipboardDataHasImage } from '@src/utils/clipboard-image';
import { COLORS, toPngName, type Stroke, type Tool } from './types';

/** The caption box grows with its text up to this height, then scrolls. */
const MAX_CAPTION_HEIGHT_PX = 144;

export interface ImageAnnotatorProps {
  open: boolean;
  /** The original image to annotate. */
  file: File | null;
  /** User saved: receives the flattened PNG File (image/png), or the untouched
   *  original when nothing was drawn, plus the trimmed caption ('' when none). */
  onSave: (annotated: File, caption: string) => void;
  /** Prefills the caption box (e.g. text pasted alongside the image). */
  initialCaption?: string;
  /**
   * Called synchronously within the Save click with a promise of the flattened
   * PNG, so a clipboard write keeps the user activation even though toBlob is
   * async (a slow toBlob on a large image would otherwise outlast the gesture
   * and the clipboard would silently keep the un-annotated original).
   */
  onClipboard: (blob: Promise<Blob>) => void;
  /** User dismissed without saving — capture is aborted (image dropped). */
  onCancel: () => void;
  /** Optional label for capture flows that submit directly instead of attaching. */
  submitLabel?: React.ReactNode;
  /** Where focus goes when the dialog closes (it has no trigger to return to). */
  onCloseAutoFocus?: (event: Event) => void;
}

export function ImageAnnotator({
  open,
  file,
  onSave,
  onClipboard,
  onCancel,
  submitLabel,
  initialCaption,
  onCloseAutoFocus,
}: ImageAnnotatorProps) {
  const { t } = useLingui();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const drawingRef = useRef<Stroke | null>(null);
  const captionRef = useRef<HTMLTextAreaElement>(null);

  const [color, setColor] = useState<string>(COLORS[0]);
  const [tool, setTool] = useState<Tool>('pen');
  const [strokeCount, setStrokeCount] = useState(0); // drives dirty + re-render
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [caption, setCaption] = useState('');

  // natural → display scale (canvas backing store vs CSS-rendered size).
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);
  scaleRef.current = scale;

  const text = useTextBoxes(scaleRef);
  // `isDirty` is the IMAGE changing (it decides re-encoding); a typed caption only
  // makes closing ask first.
  const isDirty = strokeCount > 0 || text.hasContent;
  const hasUnsaved = isDirty || caption.trim() !== (initialCaption ?? '').trim();

  // A fresh caption per opened image. Kept apart from the image load below so a
  // slow decode can't wipe what the user already typed.
  useEffect(() => {
    if (open) setCaption(initialCaption ?? '');
  }, [open, file, initialCaption]);

  // Grow the caption box with its text, up to MAX_CAPTION_HEIGHT_PX.
  useLayoutEffect(() => {
    const ta = captionRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_CAPTION_HEIGHT_PX)}px`;
  }, [caption, open]);

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
      // Annotating takes focus off the caption: the canvas can't hold focus, so
      // without this the next keystrokes would still type into the caption.
      captionRef.current?.blur();
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
      if (s.tool === 'arrow')
        s.points[1] = point; // move the end point
      else s.points.push(point);
      redraw();
    },
    [redraw, toCanvasPoint],
  );

  const onPointerUp = useCallback(() => {
    const s = drawingRef.current;
    drawingRef.current = null;
    const isDegenerateArrow = s?.tool === 'arrow' && s.points[0].x === s.points[1].x && s.points[0].y === s.points[1].y;
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
    // Nothing was drawn: attach the original image untouched. Re-encoding a
    // clean photo through the canvas would needlessly bloat it (PNG) and drop
    // its original format. No clipboard write here — that's the annotation
    // feature (copy the marked-up PNG); there's nothing new to copy, and the
    // original's MIME (e.g. image/jpeg) wouldn't match the PNG clipboard item.
    const note = caption.trim();
    if (!isDirty) {
      onSave(file, note);
      return;
    }
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
      .then((blob) =>
        onSave(new File([blob], toPngName(file.name), { type: 'image/png', lastModified: Date.now() }), note),
      )
      .catch(() => {
        /* toBlob failure is rare; nothing to attach */
      });
  }, [caption, file, isDirty, onClipboard, onSave, redraw, text.textBoxes]);

  const requestClose = useCallback(() => {
    if (hasUnsaved) {
      setConfirmDiscard(true);
      return;
    }
    onCancel();
  }, [hasUnsaved, onCancel]);

  // Enter confirms — attaching either the markup or, if nothing was drawn, the
  // original image, with the caption (Esc cancels). Document-level so it works
  // regardless of which control is focused — in the caption too, where
  // Shift+Enter falls through as a newline; skipped while editing a text box
  // (there Enter commits the text) and mid-IME composition. stopPropagation so a
  // focused button doesn't also activate.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing || text.editingId != null) return;
      e.preventDefault();
      e.stopPropagation();
      handleSave();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, text.editingId, handleSave]);

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && requestClose()}>
        <DialogContent
          hideClose
          className="flex max-h-[92vh] w-auto max-w-[92vw] flex-col gap-2 p-2"
          onCloseAutoFocus={onCloseAutoFocus}
          onOpenAutoFocus={(e) => {
            // Radix would focus the first toolbar button; the caption is where a
            // paste wants to continue.
            e.preventDefault();
            captionRef.current?.focus();
          }}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            requestClose();
          }}
        >
          <DialogTitle className="sr-only">
            <Trans>Annotate image</Trans>
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>
              Draw with the pen or arrow, add text boxes, add a caption, then Save to attach the annotated copy.
            </Trans>
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
            submitLabel={submitLabel}
          />

          {/* No tinted panel around the image: the only surface is the image
              itself, edged by a visible border, so there is no area that looks
              drawable but is not. */}
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
            <div className="relative border border-foreground/40">
              <canvas
                ref={canvasRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={onPointerUp}
                onClick={onCanvasClick}
                className="block max-h-[calc(92vh-4rem)] max-w-full touch-none"
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

          <textarea
            ref={captionRef}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            onPaste={(e) => {
              // An image pasted here would land as nothing useful; text pastes pass.
              if (clipboardDataHasImage(e.clipboardData)) e.preventDefault();
            }}
            rows={1}
            dir="auto"
            placeholder={t`Add a caption…`}
            aria-label={t`Caption`}
            data-testid="image-annotator-caption"
            className="w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          />
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title={t`Discard changes?`}
        description={t`Your markup and caption on this image will be lost.`}
        confirmLabel={t`Discard`}
        cancelLabel={t`Keep editing`}
        variant="destructive"
        onConfirm={onCancel}
      />
    </>
  );
}
