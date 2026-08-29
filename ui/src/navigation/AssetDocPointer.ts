/**
 * AssetDocPointer — the single parser/builder/validator for every asset-editor URL.
 *
 * Grammar (the pointer portion of a `ViewType.ASSETS` DockPointer):
 *   EDITOR: editor/<AssetEditor>/<AssetRoutingMethod>/<value...>
 *   WIKI:   wiki/<space>/<name...>            (space default: @local)
 *
 * The explicit `<method>` segment is the whole point: a filesystem/VFS path
 * (`vfs`) can never be mistaken for a TypeId (`typeid`), so a path value never
 * reaches `new TypeId` — the class of "Invalid typeId" crashes is impossible by
 * construction. Produces a `DockPointer` so the `navigation.openDock` chokepoint
 * is unchanged.
 */
import { Layout, TypeId, VFSPath, isTypeId } from '@sdk';
import { ViewType } from '../types/ViewType';
import { DockPointer } from './DockPointer';
import {
  AssetEditor,
  AssetMode,
  AssetPointerError,
  AssetRoutingMethod,
  DEFAULT_WIKI_SPACE,
  editorForType,
  LOCAL_COMPUTE_NODE,
  WIKI_FRAGMENT_PARAM,
} from './asset-doc-types';
import {
  assetWikiValue,
  normalizeAssetVfsPath,
  parseAssetDocPointer,
  serializeAssetDocPointer,
} from './asset-doc-pointer-grammar';

export class AssetDocPointer {
  private constructor(
    public readonly mode: AssetMode,
    /** editor mode: the method value (path | typeid). wiki mode: "<space>/<name>". */
    public readonly value: string,
    public readonly options: Record<string, string> | undefined,
    public readonly editor?: AssetEditor,
    public readonly method?: AssetRoutingMethod,
  ) {}

  // ── builders ──────────────────────────────────────────────────────────────

  /**
   * Address a file by VFS path (the only form for `code`; the fallback when no
   * entity). Tolerant of input shape: an already-compute-node-rooted vpath, an
   * absolute machine path (the common `asset_ref`), or a relative path (treated
   * as relative to the compute-node root).
   */
  static forVfs(
    editor: AssetEditor,
    pathOrVpath: string,
    computeNode: TypeId = LOCAL_COMPUTE_NODE,
    options?: Record<string, string>,
  ): AssetDocPointer {
    const vfsPath = normalizeAssetVfsPath(pathOrVpath, computeNode);
    return new AssetDocPointer(
      AssetMode.EDITOR,
      vfsPath.absVfsPath,
      options,
      editor,
      AssetRoutingMethod.VFS,
    );
  }

  /** Address an entity-backed asset by its own TypeId (the preferred, stable form). */
  static forTypeId(
    editor: AssetEditor,
    typeId: TypeId,
    options?: Record<string, string>,
  ): AssetDocPointer {
    return new AssetDocPointer(AssetMode.EDITOR, typeId.toString(), options, editor, AssetRoutingMethod.TYPEID);
  }

  /** Build from a resolved entity. Picks the editor from the entity type; prefers typeid. */
  static forEntity(
    entity: { type: string; typeId?: TypeId | null },
    options?: Record<string, string>,
  ): AssetDocPointer {
    const editor = editorForType(entity.type);
    if (!editor) throw new AssetPointerError(`no editor for type "${entity.type}"`);
    if (!entity.typeId) throw new AssetPointerError(`entity has no typeId (type "${entity.type}")`);
    return AssetDocPointer.forTypeId(editor, entity.typeId, options);
  }

  /**
   * Address a wiki link by name within a space (default @local). An optional
   * `fragment` (a heading slug, e.g. "auto-run") rides in `options` as
   * `wikiFragment` — the same query-param side-channel as `withHighlight`, so
   * the path grammar is untouched and the anchor survives back/reload/share.
   */
  static forWiki(
    name: string,
    space: string = DEFAULT_WIKI_SPACE,
    options?: Record<string, string>,
    fragment?: string,
  ): AssetDocPointer {
    const opts = fragment ? { ...(options ?? {}), [WIKI_FRAGMENT_PARAM]: fragment } : options;
    return new AssetDocPointer(AssetMode.WIKI, assetWikiValue(name, space), opts);
  }

  // ── parse ─────────────────────────────────────────────────────────────────

  /** Parse the pointer portion of a ViewType.ASSETS DockPointer. Throws on malformed input. */
  static parse(assetsPointer: string | undefined): AssetDocPointer {
    const parsed = parseAssetDocPointer(assetsPointer);
    return new AssetDocPointer(
      parsed.mode,
      parsed.value,
      undefined,
      parsed.editor,
      parsed.method,
    );
  }

  // ── wiki accessors ──────────────────────────────────────────────────────────

  get space(): string {
    return this.value.split('/')[0] ?? DEFAULT_WIKI_SPACE;
  }

  get wikiName(): string {
    return this.value.split('/').slice(1).join('/');
  }

  // ── serialize ───────────────────────────────────────────────────────────────

  toPointer(): string {
    return serializeAssetDocPointer(this);
  }

  toDockPointer(layout?: Layout): DockPointer {
    return new DockPointer(ViewType.ASSETS, this.toPointer(), this.options, layout);
  }

  // ── validate ─────────────────────────────────────────────────────────────────

  validate(): void {
    if (this.mode === AssetMode.WIKI) {
      if (!this.space || !this.wikiName) throw new AssetPointerError('wiki requires <space>/<name>');
      return;
    }
    // editor + method are guaranteed valid enums by parse()/the builders;
    // validate() only checks the value matches its method.
    if (this.method === AssetRoutingMethod.TYPEID) {
      if (this.editor === AssetEditor.CODE) {
        throw new AssetPointerError('code editor has no typeid form (file-only)');
      }
      if (!isTypeId(this.value)) throw new AssetPointerError(`invalid typeid "${this.value}"`);
    } else {
      if (this.editor === AssetEditor.APP) {
        throw new AssetPointerError('app editor has no vfs form (the entity supplies the app)');
      }
      // VFS: must carry a compute-node root so it's unambiguous across nodes.
      if (!VFSPath.parse(this.value).isAbsolute) {
        throw new AssetPointerError(`vfs value must carry a compute-node root: "${this.value}"`);
      }
    }
  }
}
