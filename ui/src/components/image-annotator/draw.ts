/** Pure canvas drawing for the annotator — shared by live redraw and Save flatten. */
import type { Stroke, TextBox } from './types';

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
  if (s.points.length === 0) return;
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  if (s.tool === 'arrow') {
    const from = s.points[0];
    const to = s.points[s.points.length - 1];
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const head = s.width * 6; // arrowhead length scales with line width
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
}

/** Redraw the base image + all strokes (+ the in-progress one). Text is overlaid in the DOM. */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  strokes: Stroke[],
  inProgress: Stroke | null,
): void {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) drawStroke(ctx, s);
  if (inProgress) drawStroke(ctx, inProgress);
}

/** Flatten the text boxes onto the canvas (called once, on Save, before export). */
export function bakeTextBoxes(ctx: CanvasRenderingContext2D, boxes: TextBox[]): void {
  ctx.textBaseline = 'top';
  for (const b of boxes) {
    if (!b.text.trim()) continue;
    ctx.fillStyle = b.color;
    ctx.font = `600 ${b.fontPx}px sans-serif`;
    let y = b.y;
    for (const line of b.text.split('\n')) {
      ctx.fillText(line, b.x, y);
      y += b.fontPx * 1.2;
    }
  }
}
