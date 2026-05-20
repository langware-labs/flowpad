/**
 * Pure-function Excalidraw → Mermaid serializer (TypeScript port).
 *
 * Paired with `flow_sdk/fs_records/_whiteboard_mermaid.py`. Both
 * implementations MUST produce byte-identical output for any given input —
 * the shared corpus under `tests/fixtures/mermaid_corpus/` enforces that
 * invariant. If you edit the algorithm here, edit the Python side too.
 */

type ExcalidrawData = Record<string, unknown> | null | undefined | unknown;

const HEADER = "flowchart TD";
const INDENT = "  ";
const ESCAPE_CHARS = new Set(["[", "]", "{", "}", "(", ")", "|", "<", ">", "\\"]);

function isDeleted(el: Record<string, unknown>): boolean {
  return Boolean(el["isDeleted"]);
}

function asNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return String(v);
}

function labelText(textEl: Record<string, unknown>): string {
  return asString(textEl["text"]).trim();
}

function escapeLabel(label: string): string {
  if (!label) return '""';
  for (const ch of label) {
    if (ESCAPE_CHARS.has(ch)) {
      return '"' + label.replace(/"/g, '\\"') + '"';
    }
  }
  return label;
}

function bboxContains(shape: Record<string, unknown>, px: number, py: number): boolean {
  const sx = asNumber(shape["x"]);
  const sy = asNumber(shape["y"]);
  const sw = asNumber(shape["width"]);
  const sh = asNumber(shape["height"]);
  return px >= sx && px <= sx + sw && py >= sy && py <= sy + sh;
}

function centerOf(el: Record<string, unknown>): [number, number] {
  const x = asNumber(el["x"]);
  const y = asNumber(el["y"]);
  const w = asNumber(el["width"]);
  const h = asNumber(el["height"]);
  return [x + w / 2, y + h / 2];
}

function arrowMidpoint(arrow: Record<string, unknown>): [number, number] {
  const pts = arrow["points"];
  if (!Array.isArray(pts) || pts.length === 0) {
    return centerOf(arrow);
  }
  const originX = asNumber(arrow["x"]);
  const originY = asNumber(arrow["y"]);
  const first = pts[0];
  const last = pts[pts.length - 1];
  const fx = Array.isArray(first) ? asNumber(first[0]) : 0;
  const fy = Array.isArray(first) ? asNumber(first[1]) : 0;
  const lx = Array.isArray(last) ? asNumber(last[0]) : 0;
  const ly = Array.isArray(last) ? asNumber(last[1]) : 0;
  return [originX + (fx + lx) / 2, originY + (fy + ly) / 2];
}

function shapeOpenClose(stype: string): [string, string] {
  if (stype === "rectangle") return ["[", "]"];
  if (stype === "diamond") return ["{{", "}}"];
  if (stype === "ellipse") return ["((", "))"];
  return ["[", "]"];
}

function formatNode(nodeId: string, stype: string, label: string): string {
  const [open, close] = shapeOpenClose(stype);
  return `${nodeId}${open}${escapeLabel(label)}${close}`;
}

function emptyBoard(): string {
  return `${HEADER}\n${INDENT}%% empty board\n`;
}

function malformed(err: string): string {
  const oneLine = err.replace(/\s+/g, " ").trim();
  return `${HEADER}\n${INDENT}%% malformed: ${oneLine}\n`;
}

export function excalidrawToMermaid(data: ExcalidrawData): string {
  try {
    if (data === null || data === undefined || typeof data !== "object" || Array.isArray(data)) {
      return emptyBoard();
    }
    const root = data as Record<string, unknown>;
    const elements = root["elements"];
    if (!Array.isArray(elements) || elements.length === 0) {
      return emptyBoard();
    }

    const shapeTypes = new Set(["rectangle", "diamond", "ellipse"]);

    // Pass 1: shape nodes in array order.
    const shapes: Record<string, unknown>[] = [];
    const idToNode: Map<string, string> = new Map();
    for (const raw of elements) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const el = raw as Record<string, unknown>;
      if (isDeleted(el)) continue;
      const stype = el["type"];
      if (typeof stype === "string" && shapeTypes.has(stype)) {
        shapes.push(el);
        const nodeId = `N${shapes.length}`;
        const elId = el["id"];
        if (typeof elId === "string") {
          idToNode.set(elId, nodeId);
        }
      }
    }

    // Pass 2: collect texts and pair them to shapes by bbox.
    const texts: Record<string, unknown>[] = [];
    for (const raw of elements) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const el = raw as Record<string, unknown>;
      if (isDeleted(el)) continue;
      if (el["type"] === "text") texts.push(el);
    }

    const usedTextIds: Set<string> = new Set();
    const shapeLabels: Map<number, string> = new Map();
    for (let i = 0; i < shapes.length; i++) {
      const shape = shapes[i];
      let label: string | null = null;
      for (const t of texts) {
        const tid = t["id"];
        if (typeof tid === "string" && usedTextIds.has(tid)) continue;
        const [cx, cy] = centerOf(t);
        if (bboxContains(shape, cx, cy)) {
          label = labelText(t);
          if (typeof tid === "string") usedTextIds.add(tid);
          break;
        }
      }
      shapeLabels.set(i, label !== null && label !== "" ? label : "Untitled");
    }

    // Pass 3: arrows → edges.
    const edgeLines: string[] = [];
    let unboundArrowCount = 0;
    for (const raw of elements) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const el = raw as Record<string, unknown>;
      if (isDeleted(el)) continue;
      if (el["type"] !== "arrow") continue;
      const sb = el["startBinding"];
      const eb = el["endBinding"];
      const sid = sb && typeof sb === "object" && !Array.isArray(sb) ? (sb as Record<string, unknown>)["elementId"] : undefined;
      const tid = eb && typeof eb === "object" && !Array.isArray(eb) ? (eb as Record<string, unknown>)["elementId"] : undefined;
      if (!(typeof sid === "string" && typeof tid === "string" && idToNode.has(sid) && idToNode.has(tid))) {
        unboundArrowCount += 1;
        continue;
      }
      const srcNode = idToNode.get(sid)!;
      const dstNode = idToNode.get(tid)!;
      const [mx, my] = arrowMidpoint(el);
      let label: string | null = null;
      for (const t of texts) {
        const txid = t["id"];
        if (typeof txid === "string" && usedTextIds.has(txid)) continue;
        const [cx, cy] = centerOf(t);
        const dx = cx - mx;
        const dy = cy - my;
        if (dx * dx + dy * dy <= 30 * 30) {
          label = labelText(t);
          if (typeof txid === "string") usedTextIds.add(txid);
          break;
        }
      }
      if (label) {
        edgeLines.push(`${srcNode} -->|${escapeLabel(label)}| ${dstNode}`);
      } else {
        edgeLines.push(`${srcNode} --> ${dstNode}`);
      }
    }

    // Build node lines.
    const nodeLines: string[] = [];
    for (let i = 0; i < shapes.length; i++) {
      const stype = asString(shapes[i]["type"]) || "rectangle";
      const label = shapeLabels.get(i) ?? "Untitled";
      nodeLines.push(formatNode(`N${i + 1}`, stype, label));
    }

    // Pass 4: loose elements bookkeeping.
    let freedrawCount = 0;
    let imageCount = 0;
    let frameCount = 0;
    let orphanTextCount = 0;
    for (const raw of elements) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const el = raw as Record<string, unknown>;
      if (isDeleted(el)) continue;
      const etype = el["type"];
      if (etype === "freedraw") freedrawCount++;
      else if (etype === "image") imageCount++;
      else if (etype === "frame") frameCount++;
      else if (etype === "text") {
        const eid = el["id"];
        if (!(typeof eid === "string" && usedTextIds.has(eid))) orphanTextCount++;
      }
    }
    const looseCategories: [string, number][] = [
      ["freedraw", freedrawCount],
      ["image", imageCount],
      ["frame", frameCount],
      ["orphan-text", orphanTextCount],
      ["unbound-arrow", unboundArrowCount],
    ];
    const looseParts: string[] = [];
    for (const [name, count] of looseCategories) {
      if (count > 0) looseParts.push(`${count} ${name}`);
    }

    if (nodeLines.length === 0 && edgeLines.length === 0 && looseParts.length === 0) {
      return emptyBoard();
    }

    const bodyLines: string[] = [];
    for (const nl of nodeLines) bodyLines.push(`${INDENT}${nl}`);
    for (const el of edgeLines) bodyLines.push(`${INDENT}${el}`);
    if (looseParts.length > 0) {
      bodyLines.push(`${INDENT}%% loose elements: ${looseParts.join(", ")}`);
    }

    return `${HEADER}\n` + bodyLines.join("\n") + "\n";
  } catch (err) {
    return malformed(err instanceof Error ? err.message : String(err));
  }
}

export default excalidrawToMermaid;
