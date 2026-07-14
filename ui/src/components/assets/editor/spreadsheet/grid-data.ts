import Papa from 'papaparse';
import type { ColumnRegular, DataType } from '@revolist/react-datagrid';

/**
 * Pure helpers mapping between raw tabular text/matrices and the RevoGrid
 * {columns, source} model. Kept side-effect-free so they're unit-testable
 * without a DOM.
 *
 * Model choice: columns are index-keyed (prop `"0"`, `"1"`, …) and NEVER assume
 * a header row — every input line is a data row. This is lossless (no
 * header/data ambiguity on round-trip) and mirrors a spreadsheet's A/B/C column
 * letters. Column display names are spreadsheet letters (A, B, …, Z, AA, …).
 */

export interface GridData {
  columns: ColumnRegular[];
  source: DataType[];
}

/** 0 → "A", 25 → "Z", 26 → "AA" (spreadsheet column letters). */
export function columnLetter(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Build index-keyed columns for `colCount` columns, optionally read-only. */
export function buildColumns(colCount: number, readonly = false): ColumnRegular[] {
  const cols: ColumnRegular[] = [];
  for (let i = 0; i < colCount; i++) {
    cols.push({ prop: String(i), name: columnLetter(i), readonly, resizable: true, size: 140 });
  }
  return cols;
}

/** A matrix (array of string rows) → {columns, source}. */
export function matrixToGrid(matrix: string[][], readonly = false): GridData {
  let maxCols = 0;
  for (const row of matrix) if (row.length > maxCols) maxCols = row.length;
  maxCols = Math.max(maxCols, 1);
  const source: DataType[] = matrix.map((row) => {
    const obj: DataType = {};
    for (let c = 0; c < maxCols; c++) obj[String(c)] = row[c] ?? '';
    return obj;
  });
  return { columns: buildColumns(maxCols, readonly), source };
}

/** Parse CSV text into a grid (no header assumption). */
export function parseCsvToGrid(text: string): GridData {
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: 'greedy',
    // Everything is a string cell — never coerce numbers, so a ZIP code or
    // leading-zero id round-trips unchanged.
    dynamicTyping: false,
  });
  const matrix = (parsed.data ?? []).filter(Array.isArray) as string[][];
  return matrixToGrid(matrix.length ? matrix : [['']], false);
}

/** RevoGrid {columns, source} → a matrix (array of string rows). */
export function gridToMatrix(columns: ColumnRegular[], source: DataType[]): string[][] {
  const props = columns.map((c) => String(c.prop));
  return source.map((row) => props.map((p) => {
    const v = row[p];
    return v == null ? '' : String(v);
  }));
}

/** Serialize the grid back to CSV text. */
export function serializeGridToCsv(columns: ColumnRegular[], source: DataType[]): string {
  return Papa.unparse(gridToMatrix(columns, source));
}

/**
 * Apply a RevoGrid `afteredit` event detail to `source` in place. Handles both
 * a single-cell edit ({prop, rowIndex, val}) and a range/paste
 * ({data: {rowIndex: model}}).
 */
export function applyEditToSource(source: DataType[], detail: unknown): void {
  if (!detail || typeof detail !== 'object') return;
  const d = detail as Record<string, unknown>;
  // Range / paste edit: has a `data` map keyed by row index and no single-cell
  // `prop` (a single-cell edit is discriminated purely by `prop`, below).
  if ('data' in d && !('prop' in d)) {
    const data = d.data as Record<string, DataType> | undefined;
    if (data) {
      for (const [ri, model] of Object.entries(data)) {
        const i = Number(ri);
        if (!source[i]) source[i] = {};
        Object.assign(source[i], model);
      }
    }
    return;
  }
  // Single-cell edit.
  if (typeof d.rowIndex === 'number' && d.prop != null) {
    const i = d.rowIndex;
    if (!source[i]) source[i] = {};
    source[i][String(d.prop)] = d.val ?? '';
  }
}
