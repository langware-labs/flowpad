/**
 * Text-box state + interactions for the annotator, kept separate from the
 * pen/arrow (canvas) model: each box has its own edit/drag/delete lifecycle and
 * is NOT part of the pen/arrow undo stack.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { TextBox } from './types';

export interface UseTextBoxes {
  textBoxes: TextBox[];
  editingId: number | null;
  selectedId: number | null;
  /** Ref callback factory that seeds each editable span's text exactly once. */
  registerSpan: (id: number, text: string) => (el: HTMLSpanElement | null) => void;
  reset: () => void;
  addTextBox: (x: number, y: number, color: string, fontPx: number) => void;
  updateText: (id: number, text: string) => void;
  commitText: (id: number) => void;
  deleteText: (id: number) => void;
  recolorSelected: (color: string) => void;
  select: (id: number) => void;
  startEdit: (id: number) => void;
  onBoxPointerDown: (e: React.PointerEvent<HTMLElement>, box: TextBox) => void;
  /** True if any box has non-whitespace text (contributes to "dirty"). */
  hasContent: boolean;
}

export function useTextBoxes(scaleRef: RefObject<number>): UseTextBoxes {
  const [textBoxes, setTextBoxes] = useState<TextBox[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const nextId = useRef(1);
  const spanRefs = useRef<Map<number, HTMLSpanElement>>(new Map());
  const dragRef = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null);

  const reset = useCallback(() => {
    setTextBoxes([]);
    setEditingId(null);
    setSelectedId(null);
  }, []);

  const addTextBox = useCallback((x: number, y: number, color: string, fontPx: number) => {
    const id = nextId.current++;
    setTextBoxes((prev) => [...prev, { id, x, y, color, fontPx, text: '' }]);
    setSelectedId(id);
    setEditingId(id);
  }, []);

  const updateText = useCallback((id: number, text: string) => {
    setTextBoxes((prev) => prev.map((t) => (t.id === id ? { ...t, text } : t)));
  }, []);

  const commitText = useCallback((id: number) => {
    setEditingId((cur) => (cur === id ? null : cur));
    // Drop a box left empty (created then clicked away without typing).
    setTextBoxes((prev) => prev.filter((t) => t.id !== id || t.text.trim() !== ''));
  }, []);

  const deleteText = useCallback((id: number) => {
    setTextBoxes((prev) => prev.filter((t) => t.id !== id));
    setEditingId((cur) => (cur === id ? null : cur));
    setSelectedId((cur) => (cur === id ? null : cur));
  }, []);

  const recolorSelected = useCallback(
    (color: string) => {
      if (selectedId == null) return;
      setTextBoxes((prev) => prev.map((t) => (t.id === selectedId ? { ...t, color } : t)));
    },
    [selectedId],
  );

  const select = useCallback((id: number) => setSelectedId(id), []);
  const startEdit = useCallback((id: number) => {
    setSelectedId(id);
    setEditingId(id);
  }, []);

  const onBoxPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, box: TextBox) => {
      if (editingId === box.id) return; // let the caret work while editing
      e.stopPropagation();
      setSelectedId(box.id);
      dragRef.current = { id: box.id, sx: e.clientX, sy: e.clientY, ox: box.x, oy: box.y };
    },
    [editingId],
  );

  const registerSpan = useCallback(
    (id: number, text: string) => (el: HTMLSpanElement | null) => {
      if (!el) {
        spanRefs.current.delete(id);
        return;
      }
      spanRefs.current.set(id, el);
      // Seed the DOM text once; thereafter the element owns it (no JSX children →
      // React never rewrites it, so editing never fights the caret).
      if (el.dataset.init !== '1') {
        el.textContent = text;
        el.dataset.init = '1';
      }
    },
    [],
  );

  // Focus + place caret at end whenever a box enters edit mode.
  useEffect(() => {
    if (editingId == null) return;
    const el = spanRefs.current.get(editingId);
    if (!el) return;
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }, [editingId]);

  // Drag the selected box (window-level so the pointer can leave the box).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const s = scaleRef.current || 1;
      const nx = d.ox + (e.clientX - d.sx) / s;
      const ny = d.oy + (e.clientY - d.sy) / s;
      setTextBoxes((prev) => prev.map((t) => (t.id === d.id ? { ...t, x: nx, y: ny } : t)));
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [scaleRef]);

  return {
    textBoxes,
    editingId,
    selectedId,
    registerSpan,
    reset,
    addTextBox,
    updateText,
    commitText,
    deleteText,
    recolorSelected,
    select,
    startEdit,
    onBoxPointerDown,
    hasContent: textBoxes.some((t) => t.text.trim() !== ''),
  };
}
