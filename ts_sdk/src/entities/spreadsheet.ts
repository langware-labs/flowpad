import { APIEntity, registerEntity } from '../APIEntity';
import { DockPointerData } from '../models/DockPointer';

/**
 * Spreadsheet entity — a flat tabular file (`.csv` or `.xlsx`) backed by a
 * SpreadsheetRecord on disk, discovered anywhere in a project (like markdown).
 *
 * `asset_ref` is the file itself. The grid editor reads it: CSV is editable and
 * saved back through the plain-text FS write path; XLSX is parsed frontend-side
 * (SheetJS) and shown read-only. `format` ("csv" | "xlsx") drives that branch.
 */
@registerEntity
export class Spreadsheet extends APIEntity<Spreadsheet> {
  static type: string = 'spreadsheet';
  static override icon = 'Table';

  title: string = '';
  description: string = '';
  asset_ref?: string;
  /** "csv" | "xlsx" — the on-disk format; drives the editable-vs-readonly branch. */
  format?: string;
  num_rows?: number;
  num_cols?: number;
  /** XLSX workbook sheet names (empty for CSV). */
  sheet_names?: string[];

  constructor(entity: Partial<Spreadsheet> = {}) {
    super(entity);
    this.title = entity.title ?? '';
    this.description = entity.description ?? '';
    this.asset_ref = entity.asset_ref;
    this.format = entity.format;
    this.num_rows = entity.num_rows;
    this.num_cols = entity.num_cols;
    this.sheet_names = entity.sheet_names ?? [];
  }

  /** Default open target: the spreadsheet grid editor (URL-first target). */
  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer('spreadsheet') ?? super.dockPointer;
  }

  override get editorDockPointer(): DockPointerData {
    return this.assetEditorPointer('spreadsheet') ?? super.editorDockPointer;
  }

  override get searchDockPointer(): DockPointerData {
    return this.assetEditorPointer('spreadsheet') ?? this.dockPointer;
  }
}
