/**
 * Dataset — a folder of examples (flow_sdk/builtin/dataset.py). When bound to a
 * DataSource (`source_id`) its rows are that source's items: `promote` turns
 * items into examples, `annotate` writes an example's gold label.
 */
import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';
import type { EvalExampleRow, EvalRun } from '../evals/types';

/** The kinds an authored field may take. Mirrors the backend's declaration —
 *  `flow_sdk/schema/data_spec/_kinds.py` PRIMITIVES plus the one-element list
 *  form the authoring grammar accepts (`["string"]`). */
export const DATASET_FIELD_KINDS = ['string', 'int', 'float', 'bool'] as const;
export type DatasetFieldKind = (typeof DATASET_FIELD_KINDS)[number] | [(typeof DATASET_FIELD_KINDS)[number]];

/** A typed value from what a person typed, by the shape's kind — the inverse of
 *  the authoring form. Same job the backend's `FieldHints.coerce` does for
 *  a source's config; this one is for a dataset's output shape. */
export function coerceToKind(kind: unknown, text: string): unknown {
  if (Array.isArray(kind))
    return text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  if (kind === 'int') return parseInt(text, 10);
  if (kind === 'float') return Number(text);
  if (kind === 'bool') return text === 'true';
  return text;
}

/** The keyword authoring form of a dataset shape: one row describes every row. */
export interface DatasetAuthoringSpec {
  examples: [{ input: unknown; output?: unknown; ground_truth?: unknown; context?: unknown }];
}

/** What `spec` holds: the inline form, or the NAME of a registered dataset kind
 *  (`navigator.dataset`, `--acme--.orders.dataset`) — typically one a `data_spec` folder defines. */
export type DatasetSpecForm = DatasetAuthoringSpec | string;

/** One row going in: `input` required, the other slots and the row's role optional. */
export interface DatasetRowInput {
  input: unknown;
  context?: unknown;
  ground_truth?: unknown;
  output?: unknown;
  kind?: 'train' | 'eval' | 'test';
  data?: Record<string, unknown>;
}

/** One row read back with its slots' VALUES (`GET example/<id>`). */
export interface DatasetRow extends DatasetRowInput {
  id: string;
  kind: 'train' | 'eval' | 'test';
  metadata: Record<string, unknown>;
}

export interface IDataset extends IEntity {
  title?: string;
  description?: string | null;
  source_id?: string;
  data_layout?: 'csv' | 'io_folder';
  field_spec?: Record<string, string>;
  delimiter?: string;
  spec?: DatasetSpecForm | null;
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
  spec: DatasetSpecForm | null = null;
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

  /** The output shape of one row, in authoring form (`{field: kind}`), or null — null too when
   *  `spec` NAMES a kind: that shape lives in the kind (see `GET /api/v1/kinds/<kind>`). */
  get outputShape(): unknown {
    return typeof this.spec === 'string' ? null : (this.spec?.examples?.[0]?.output ?? null);
  }

  /** The registered kind every row is, when `spec` names one; else null. */
  get specKind(): string | null {
    return typeof this.spec === 'string' ? this.spec : null;
  }

  /** The rows as the disk holds them: which item each came from, and whether it carries gold.
   *  NOT named `examples`: a dataset read by id carries an `examples` FIELD on the wire, and
   *  assigning it onto the instance hid a method of that name ("examples is not a function"). */
  async listExamples(): Promise<{
    examples: { example_id: string; item_id: string | null; kind: string; annotated: boolean }[];
  }> {
    return this.get('examples');
  }

  /** Items → examples. Returns the new example ids. */
  async promote(sourceItemIds: string[]): Promise<{ example_ids: string[]; num_examples: number }> {
    return this.post('promote', { source_item_ids: sourceItemIds });
  }

  /** Typed rows in — each checked against the declared shape; one bad row writes nothing. */
  async append(rows: DatasetRowInput[]): Promise<{ example_ids: string[]; num_examples: number }> {
    return this.post('append', { rows });
  }

  /** Every example with its slots' values, in one read. */
  async rows(): Promise<{ rows: DatasetRow[] }> {
    return this.get('rows');
  }

  /** Every eval run on this dataset, newest first (summaries — no slices). */
  async evalRuns(): Promise<{ runs: EvalRun[]; count_metrics: string[]; explain: Record<string, Record<string, string>> }> {
    return this.get('evals');
  }

  /** One eval run: the run and every evaluated example, joined to its input / context / data. */
  async evalRun(runId: string): Promise<{ run: EvalRun; examples: EvalExampleRow[]; count_metrics: string[]; explain: Record<string, string> }> {
    return this.get(`eval/${encodeURIComponent(runId)}`);
  }

  /** Run this dataset's eval now; answers the new run. */
  async runEval(options: { eval?: string; kinds?: string[] } = {}): Promise<EvalRun> {
    return this.post('run-eval', options);
  }

  /** One example with its slots' values. */
  async example(exampleId: string): Promise<DatasetRow> {
    return this.get(`example/${encodeURIComponent(exampleId)}`);
  }

  /** Every row checked against the declared shape; `problems` names the rows that do not fit. */
  async validate(): Promise<{ checked: number; problems: { example_id: string; error: string }[] }> {
    return this.post('validate', {});
  }

  /** Write one example's gold label (validated against the output shape). */
  async annotate(exampleId: string, groundTruth: unknown): Promise<{ example_id: string; num_annotated: number }> {
    return this.post('annotate', { example_id: exampleId, ground_truth: groundTruth });
  }
}
