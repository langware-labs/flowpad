import { APIEntity, registerEntity } from '../APIEntity';
import { DockPointerData } from '../models/DockPointer';

/**
 * Deck entity — a generated presentation, backed by a DeckRecord on disk
 * (<project>/assets/decks/<name>/), produced by the `decker` skill.
 *
 * Folder layout:
 *   <name>/deck.json    — build record {title, template, slides[]}
 *   <name>/<name>.html  — self-contained Reveal deck (inlined CSS/JS + base64 media)
 *
 * `asset_ref` is the folder; the DeckViewer reads `<folder>/<html_file>` and
 * frames it (fullscreen, provenance). `template_ref` links back to the source
 * deck_template. Modeled on DeckTemplate.
 */
@registerEntity
export class Deck extends APIEntity<Deck> {
  static type: string = 'deck';
  static override icon = 'Play';

  title: string = '';
  description: string = '';
  asset_ref?: string;
  /** Source deck_template entity id (undefined until the template is indexed). */
  template_ref?: string;
  num_slides?: number;
  /** The assembled output HTML filename inside the folder. */
  html_file?: string;

  constructor(entity: Partial<Deck> = {}) {
    super(entity);
    this.title = entity.title ?? '';
    this.description = entity.description ?? '';
    this.asset_ref = entity.asset_ref;
    this.template_ref = entity.template_ref;
    this.num_slides = entity.num_slides;
    this.html_file = entity.html_file;
  }

  /** Default open target: the deck presenter viewer (URL-first target). */
  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer('deck') ?? this.defaultDockPointer;
  }

  override get editorDockPointer(): DockPointerData {
    return this.assetEditorPointer('deck') ?? super.editorDockPointer;
  }

  override get searchDockPointer(): DockPointerData {
    return this.assetEditorPointer('deck') ?? this.dockPointer;
  }
}
