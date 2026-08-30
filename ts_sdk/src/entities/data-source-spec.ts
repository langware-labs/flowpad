/**
 * DataSourceSpec — the AUTHORED half of a data source
 * (flow_sdk/builtin/data_source_spec.py).
 *
 * `DataSource` is a configured instance: credentials, schedule, health,
 * cursors. This is what a source *is* — a folder asset carrying the manifest.
 * The split is the same one `GraphWorkflow` / `GraphWorkflowRun` already makes.
 *
 * It is why the create form no longer hardcodes a catalog: `config`
 * comes from the backend, so a new source lights the form up without a
 * frontend release.
 */
import type { EntityMerge } from '../IEntity';
import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

/**
 * What a config field renders as. Mirrors `FieldType` in
 * `flow_sdk/ingest/manifest.py`, which validates it at parse time — so a typo
 * is a manifest load error there and a compile error at the three comparison
 * sites here, instead of silently rendering a text input.
 */
export enum FieldType {
  TEXT = 'text',
  LINES = 'lines',
  CSV = 'csv',
  NUMBER = 'number',
  PATH = 'path',
}

/** One field of the create form, as the manifest declares it. */
export interface SpecConfigField {
  type?: FieldType;
  required?: boolean;
  label?: string;
  hint?: string;
  placeholder?: string;
  default?: unknown;
  advanced?: boolean;
  /** Regex the value must match — replaces the per-provider validators. */
  pattern?: string;
  /** Marks the field naming the remote account. Descriptive only. */
  account_key?: boolean;
}

export interface IDataSourceSpec extends IEntity {
  title?: string;
  description?: string;
  icon_name?: string;
  setup_wiki?: string;
  runtime?: string;
  reflect?: string[];
  /** The form's fields, under the manifest's own key. */
  config?: Record<string, SpecConfigField>;
  auth?: Record<string, unknown> | null;
  traits?: Record<string, unknown> | null;
  requires?: Record<string, string>;
  manifest_schema?: number;
}

// `implements IDataSourceSpec` only checks the class; it contributes no members, so every
// field declared solely on IDataSourceSpec read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DataSourceSpec extends EntityMerge<IDataSourceSpec> {}

@registerEntity
export class DataSourceSpec extends APIEntity<DataSourceSpec> implements IDataSourceSpec {
  static type: string = 'data_source_spec';

  title: string = '';
  description: string = '';
  /**
   * A lucide glyph for THIS source in the provider picker.
   *
   * Deliberately not `icon`: `APIEntity.icon` is a getter with no setter that
   * returns the TYPE's registry glyph — the one every spec shares. A row
   * carrying an `icon` key is assigned onto the instance during hydration and
   * throws there, inside the query, which empties the result instead of
   * raising. That blanked the entire provider list once already. `Group.icon`
   * shows the other way out (override with an accessor pair); a per-source
   * glyph does not need that name at all.
   */
  icon_name: string = '';
  setup_wiki: string = '';
  runtime: string = 'builtin';
  reflect: string[] = [];
  config: Record<string, SpecConfigField> = {};
  auth: Record<string, unknown> | null = null;
  traits: Record<string, unknown> | null = null;
  requires: Record<string, string> = {};
  manifest_schema: number = 1;

  /**
   * Re-apply the payload after construction.
   *
   * `ts_sdk` compiles with `useDefineForClassFields: false`, so every field
   * initializer above is emitted as an assignment AFTER `super(json)` — which
   * means the base constructor's `deepAssign` lands first and each default
   * then overwrites it. A row fetched by a LIST query (`castAndDeepAssign`'s
   * cache-miss branch is the only `new` path) therefore arrives with `title`
   * empty and `config` `{}`; entities normally recover because a later
   * by-id fetch or `data_op` deep-assigns onto the cached instance, but the Add
   * dialog reads the specs immediately and rendered bare provider names with no
   * fields at all.
   *
   * `Team`, `Group` and `Prompt` carry hand-written constructors for the same
   * reason — this is the fourth, and copies do not scale: they protect only the
   * classes that remembered. The real home for the fix is
   * `FlowSync/store.ts::castAndDeepAssign`, whose cache-HIT branch already does
   * the careful thing (onEntityUpdate, the `state` guard, the
   * `asset_occurrences` array-replace, `_rehydrateContextEntities`) while its
   * cache-MISS branch is a bare `new entityConstructor(source)` that gets none
   * of it. Fixing it there must land alone: `deepAssign` merges arrays by index
   * (the reason the `asset_occurrences` special case exists), so it is safe over
   * an empty default and would UNION for any class with a non-empty one.
   */
  constructor(json: IDataSourceSpec | undefined = undefined) {
    super(json as never);
    if (json) dataManager.deepAssign(this, json);
  }
}
