/**
 * `spreadsheet` entity + editor wiring contract (api tier).
 *
 * A tabular file (.csv / .xlsx) is a first-class `spreadsheet` entity discovered
 * anywhere in a project (flat file, like markdown). This proves the wiring end
 * to end against a real backend:
 *   1. `POST fs-records/index?type=spreadsheet&path=<file>` resolves the file
 *      via `extract_spreadsheet` → a `spreadsheet` entity (returns its typeid).
 *   2. the GET returns the shape the editor reads (type, name, asset_ref).
 *   3. the frontend routes that type — and the .csv/.xlsx extensions — to the
 *      SpreadsheetAssetEditor (`editorForType` / `editorForPath`).
 *
 * Requires: a running backend at localhost:$LOCAL_SERVER_PORT (api project).
 */
import { AssetEditor, apiClient, editorForPath, editorForType, GRAPH_API_PREFIX, RecordType } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('spreadsheet entity — indexes with the editor shape and routes to the grid editor', () => {
  beforeEach(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);
  });

  it('routes the SPREADSHEET type and .csv/.xlsx paths to the spreadsheet editor (pure)', () => {
    expect(editorForType(RecordType.SPREADSHEET)).toBe(AssetEditor.SPREADSHEET);
    expect(editorForPath('/p/data.csv')).toBe(AssetEditor.SPREADSHEET);
    expect(editorForPath('/p/book.xlsx')).toBe(AssetEditor.SPREADSHEET);
  });

  it('indexing a .csv file mints a spreadsheet entity anchored at the file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-fe-'));
    const csvPath = path.join(root, 'quarterly.csv');
    fs.writeFileSync(csvPath, 'region,revenue\nEMEA,120\nAPAC,90\n');

    const url =
      `${GRAPH_API_PREFIX}/compute_node/@local/fs-records/index` +
      `?type=spreadsheet&path=${encodeURIComponent(csvPath)}`;
    const result: any = await apiClient.post(url, {});
    expect(result?.type).toBe('spreadsheet');
    expect(result?.indexed, 'spreadsheet extractor must index the file').toBe(1);
    expect(result?.typeid, 'single-file index returns the entity typeid').toMatch(/^spreadsheet-/);

    const id = String(result.typeid).replace(/^spreadsheet-/, '');
    const entity: any = await apiClient.get(`/graph/spreadsheet/${id}`).then((r: any) => r?.data ?? r);
    expect(entity.type).toBe('spreadsheet');
    expect(entity.name).toBe('quarterly.csv');
    // asset_ref is the FILE itself (file-layout). Match on suffix — the backend
    // resolves symlinks (macOS /private prefix).
    expect(entity.asset_ref).toMatch(/quarterly\.csv$/);
  }, 15000);
});
