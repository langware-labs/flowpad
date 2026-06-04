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
  isAssetEditor,
  isAssetRoutingMethod,
} from './asset-doc-types';

/** Default compute-node root used when a caller only has a machine path. */
const LOCAL_COMPUTE_NODE = new TypeId('compute_node', DEFAULT_WIKI_SPACE);

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
    const parsed = VFSPath.parse(pathOrVpath);
    const absVfs = parsed.isAbsolute
      ? parsed.absVfsPath
      : VFSPath.fromMachinePath(
          pathOrVpath.startsWith('/') || /^[A-Za-z]:[/\\]/.test(pathOrVpath) ? pathOrVpath : `/${pathOrVpath}`,
          computeNode,
        ).absVfsPath;
    return new AssetDocPointer(AssetMode.EDITOR, absVfs, options, editor, AssetRoutingMethod.VFS);
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

  /** Address a wiki link by name within a space (default @local). */
  static forWiki(
    name: string,
    space: string = DEFAULT_WIKI_SPACE,
    options?: Record<string, string>,
  ): AssetDocPointer {
    return new AssetDocPointer(AssetMode.WIKI, `${space}/${name}`, options);
  }

  // ── parse ─────────────────────────────────────────────────────────────────

  /** Parse the pointer portion of a ViewType.ASSETS DockPointer. Throws on malformed input. */
  static parse(assetsPointer: string | undefined): AssetDocPointer {
    const parts = (assetsPointer ?? '').split('/');
    const mode = parts[0];

    if (mode === AssetMode.WIKI) {
      const space = parts[1] ?? '';
      const name = parts.slice(2).join('/');
      return new AssetDocPointer(AssetMode.WIKI, `${space}/${name}`, undefined);
    }

    if (mode === AssetMode.EDITOR) {
      const editor = parts[1] ?? '';
      const method = parts[2] ?? '';
      const value = parts.slice(3).join('/');
      if (!isAssetEditor(editor)) throw new AssetPointerError(`unknown editor "${editor}"`);
      if (!isAssetRoutingMethod(method)) throw new AssetPointerError(`unknown routing method "${method}"`);
      return new AssetDocPointer(AssetMode.EDITOR, value, undefined, editor, method);
    }

    throw new AssetPointerError(`unknown mode "${mode}"`);
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
    if (this.mode === AssetMode.WIKI) return `${AssetMode.WIKI}/${this.value}`;
    return `${AssetMode.EDITOR}/${this.editor}/${this.method}/${this.value}`;
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
      // VFS: must carry a compute-node root so it's unambiguous across nodes.
      if (!VFSPath.parse(this.value).isAbsolute) {
        throw new AssetPointerError(`vfs value must carry a compute-node root: "${this.value}"`);
      }
    }
  }
}
