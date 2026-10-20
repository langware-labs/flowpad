import { APIEntity, registerEntity } from '../APIEntity';
import { DockPointerData } from '../models/DockPointer';

/**
 * DocumentFile entity — a read-only `.docx` / `.txt` file inside a docs folder,
 * listed with the markdown Documents. `asset_ref` is the file; the preview
 * reads it (`format` "docx" | "txt" picks the renderer). Never written.
 */
@registerEntity
export class DocumentFile extends APIEntity<DocumentFile> {
  static type: string = 'document_file';
  static override icon = 'FileText';

  title: string = '';
  asset_ref?: string;
  /** "docx" | "txt" — the on-disk format. */
  format?: string;

  constructor(entity: Partial<DocumentFile> = {}) {
    super(entity);
    this.title = entity.title ?? '';
    this.asset_ref = entity.asset_ref;
    this.format = entity.format;
  }

  /** Default open target: the read-only preview (URL-first target). */
  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer() ?? this.defaultDockPointer;
  }

  override get editorDockPointer(): DockPointerData {
    return this.assetEditorPointer() ?? super.editorDockPointer;
  }
}
