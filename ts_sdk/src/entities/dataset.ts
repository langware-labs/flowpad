/**
 * Dataset — a folder of examples (flow_sdk/builtin/dataset.py). When bound to a
 * DataSource (`source_id`) its rows are that source's items: `promote` turns
 * items into examples, `annotate` writes an example's gold label.
 */
import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';

/** The kinds an authored field may take. Mirrors the backend's declaration —
 *  `flow_sdk/schema/data_spec/_kinds.py` PRIMITIVES plus the one-element list
 *  form the authoring grammar accepts (`["string"]`). */
export const DATASET_FIELD_KINDS = ['string', 'int', 'float', 'bool'] as const;
export type DatasetFieldKind = (typeof DATASET_FIELD_KINDS)[number] | [(typeof DATASET_FIELD_KINDS)[number]];

/** A typed value from what a person typed, by the shape's kind — the inverse of
 *  the authoring form. Same job the backend's `ConfigFieldSpec.coerce` does for
 *  a source's config; this one is for a dataset's output shape. */
export function coerceToKind(kind: unknown, text: string): unknown {
  if (Array.isArray(kind)) return text.split(',').map((s) => s.trim()).filter(Boolean);
  if (kind === 'int') return parseInt(text, 10);
  if (kind === 'float') return Number(text);
  if (kind === 'bool') return text === 'true';
  return text;
}

/** The keyword authoring form of a dataset shape: one row describes every row. */
export interface DatasetAuthoringSpec {
  examples: [{ input: unknown; output?: unknown; ground_truth?: unknown; context?: unknown }];
}

export interface IDataset extends IEntity {
  title?: string;
  description?: string | null;
  source_id?: string;
  data_layout?: 'csv' | 'io_folder';
  field_spec?: Record<string, string>;
  delimiter?: string;
  spec?: DatasetAuthoringSpec | null;
  num_examples?: number;
  kind_counts?: Record<string, number>;
  num_annotated?: number;
  asset_ref?: string;
}

// `implements IDataset` only checks the class; it contributes no members, so every
// field declared solely on IDataset read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Dataset extends EntityMerge<IDataset> {}

@registerEntity
export class Dataset extends APIEntity<Dataset> implements IDataset {
  static type: string = 'dataset';

  title: string = '';
  description: string | null = null;
  source_id: string = '';
  data_layout: 'csv' | 'io_folder' = 'csv';
  field_spec: Record<string, string> = {};
  delimiter: string = ',';
  spec: DatasetAuthoringSpec | null = null;
  num_examples: number = 0;
  kind_counts: Record<string, number> = {};
  num_annotated: number = 0;
  asset_ref: string = '';

  constructor(entity: Partial<IDataset> = {}) {
    super(entity);
    this.title = entity.title ?? this.title;
    this.description = entity.description ?? this.description;
    this.source_id = entity.source_id ?? this.source_id;
    this.data_layout = entity.data_layout ?? this.data_layout;
    this.field_spec = entity.field_spec ?? this.field_spec;
    this.delimiter = entity.delimiter ?? this.delimiter;
    this.spec = entity.spec ?? this.spec;
    this.num_examples = entity.num_examples ?? this.num_examples;
    this.kind_counts = entity.kind_counts ?? this.kind_counts;
    this.num_annotated = entity.num_annotated ?? this.num_annotated;
    this.asset_ref = entity.asset_ref ?? this.asset_ref;
  }

  /** A dataset that curates a source's items: rows are the item envelope, the
   *  output is the shape the person chose. The `input` kind is the ingest
   *  envelope's registered name — spelled once, here. */
  static forSource(sourceId: string, name: string, output: Record<string, unknown>): Dataset {
    return new Dataset({
      name,
      title: name,
      source_id: sourceId,
      data_layout: 'io_folder',
      spec: { examples: [{ input: 'ingest.source_item', output }] },
    });
  }

  /** The output shape of one row, in authoring form (`{field: kind}`), or null. */
  get outputShape(): unknown {
    return this.spec?.examples?.[0]?.output ?? null;
  }

  /** The rows as the disk holds them: which item each came from, and whether it carries gold. */
  async examples(): Promise<{ examples: { example_id: string; item_id: string | null; kind: string; annotated: boolean }[] }> {
    return this.get('examples');
  }

  /** Items → examples. Returns the new example ids. */
  async promote(sourceItemIds: string[]): Promise<{ example_ids: string[]; num_examples: number }> {
    return this.post('promote', { source_item_ids: sourceItemIds });
  }

  /** Write one example's gold label (validated against the output shape). */
  async annotate(exampleId: string, groundTruth: unknown): Promise<{ example_id: string; num_annotated: number }> {
    return this.post('annotate', { example_id: exampleId, ground_truth: groundTruth });
  }
}
