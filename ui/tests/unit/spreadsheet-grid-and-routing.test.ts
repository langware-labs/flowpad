/**
 * Pure unit coverage for the spreadsheet editor:
 *  - routing: RecordType.SPREADSHEET ↔ AssetEditor.SPREADSHEET, and
 *    csv/xlsx extensions → the spreadsheet editor (dual routing like markdown).
 *  - grid-data: CSV ⇄ grid round-trip, ragged rows, edit application, column
 *    letters. No DOM / backend — these are the deterministic contract.
 */
import { describe, expect, it } from 'vitest';
import {
  AssetEditor,
  editorForPath,
  editorForType,
  isFileOnlyEditor,
  RecordType,
  Spreadsheet,
} from '@sdk';
import {
  applyEditToSource,
  buildColumns,
  columnLetter,
  gridToMatrix,
  matrixToGrid,
  parseCsvToGrid,
  serializeGridToCsv,
} from '@src/components/assets/editor/spreadsheet/grid-data';

describe('spreadsheet routing', () => {
  it('maps the SPREADSHEET record type to the SPREADSHEET editor', () => {
    expect(editorForType(RecordType.SPREADSHEET)).toBe(AssetEditor.SPREADSHEET);
  });

  it('routes .csv and .xlsx files to the SPREADSHEET editor', () => {
    expect(editorForPath('/p/data.csv')).toBe(AssetEditor.SPREADSHEET);
    expect(editorForPath('/p/book.xlsx')).toBe(AssetEditor.SPREADSHEET);
    expect(editorForPath('/p/BOOK.XLSX')).toBe(AssetEditor.SPREADSHEET); // case-insensitive
  });

  it('is entity-backed (not file-only) so it rides the reindex→refresh loop', () => {
    expect(isFileOnlyEditor(AssetEditor.SPREADSHEET)).toBe(false);
  });

  it('registers the Spreadsheet entity with the spreadsheet type + copies fields', () => {
    // Static `type` is the routing key (used by EntityResolutionGate); instance
    // `.type` comes from the wire payload, not the static, so we don't assert it here.
    expect(Spreadsheet.type).toBe('spreadsheet');
    const s = new Spreadsheet({ format: 'csv', num_rows: 2, sheet_names: ['A'] });
    expect(s.format).toBe('csv');
    expect(s.num_rows).toBe(2);
    expect(s.sheet_names).toEqual(['A']);
  });
});

describe('grid-data: column letters', () => {
  it('produces spreadsheet-style letters', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(27)).toBe('AB');
  });
  it('builds index-keyed columns', () => {
    const cols = buildColumns(3);
    expect(cols.map((c) => c.prop)).toEqual(['0', '1', '2']);
    expect(cols.map((c) => c.name)).toEqual(['A', 'B', 'C']);
  });
  it('marks columns readonly when asked', () => {
    expect(buildColumns(1, true)[0].readonly).toBe(true);
    expect(buildColumns(1, false)[0].readonly).toBe(false);
  });
});

describe('grid-data: CSV round-trip', () => {
  it('parses CSV into an index-keyed grid (no header assumption)', () => {
    const { columns, source } = parseCsvToGrid('name,age\nalice,30\nbob,25\n');
    expect(columns.map((c) => c.prop)).toEqual(['0', '1']);
    expect(source).toEqual([
      { '0': 'name', '1': 'age' },
      { '0': 'alice', '1': '30' },
      { '0': 'bob', '1': '25' },
    ]);
  });

  it('serializes a grid back to well-formed CSV', () => {
    const grid = parseCsvToGrid('a,b\n1,2\n');
    const csv = serializeGridToCsv(grid.columns, grid.source);
    // Round-trips through parse again to the same matrix.
    expect(gridToMatrix(grid.columns, grid.source)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsvToGrid(csv).source).toEqual(grid.source);
  });

  it('pads ragged rows to the max column count', () => {
    const { columns, source } = parseCsvToGrid('a,b,c\n1,2\n');
    expect(columns).toHaveLength(3);
    expect(source[1]).toEqual({ '0': '1', '1': '2', '2': '' });
  });

  it('preserves leading-zero values as strings (no numeric coercion)', () => {
    const { source } = parseCsvToGrid('zip\n01234\n');
    expect(source[1]['0']).toBe('01234');
  });
});

describe('grid-data: edit application', () => {
  it('applies a single-cell edit in place', () => {
    const { source } = matrixToGrid([['a', 'b'], ['1', '2']]);
    applyEditToSource(source, { rowIndex: 1, prop: '0', val: '99' });
    expect(source[1]).toEqual({ '0': '99', '1': '2' });
  });

  it('applies a range/paste edit', () => {
    const { source } = matrixToGrid([['a', 'b'], ['1', '2']]);
    applyEditToSource(source, { data: { 0: { '1': 'B' }, 1: { '0': 'X' } } });
    expect(source[0]).toMatchObject({ '1': 'B' });
    expect(source[1]).toMatchObject({ '0': 'X' });
  });

  it('a single edit then serialize reflects the new value', () => {
    const grid = parseCsvToGrid('a,b\n1,2\n');
    applyEditToSource(grid.source, { rowIndex: 1, prop: '1', val: '42' });
    expect(serializeGridToCsv(grid.columns, grid.source)).toBe('a,b\r\n1,42');
  });
});
