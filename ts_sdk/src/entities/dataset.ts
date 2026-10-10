/**
 * Dataset — a folder of examples (flow_sdk/builtin/dataset.py). When bound to a
 * DataSource (`source_id`) its rows are that source's items: `promote` turns
 * items into examples, `annotate` writes an example's gold label.
 */
import { APIEntity, registerEntity } from '../APIEntity';
import apiClient from '../client';
import { IEntity, EntityMerge } from '../IEntity';
import type { EvalExampleRow, EvalRun, EvalTrace } from '../evals/types';
import { ExpressionNode, type MatchMap, type OrderByType } from '../FlowSync/query';
import { EventBus, targetOf } from '../tags/EventBus';
import { startTagBridge } from '../tags/ws-bridge';

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
 *  (`navigator.dataset`, `--acme--.orders.dataset`) — typically one a `data_schema` folder defines. */
export type DatasetSpecForm = DatasetAuthoringSpec | string;

/** One row going in: `input` required, the other slots and the row's role optional. */
export interface DatasetRowInput {
  /** The row's key — its example folder's name (`a-z 0-9 _ -`). Append numbers a row without one. */
  key?: string;
  input: unknown;
  context?: unknown;
  ground_truth?: unknown;
  output?: unknown;
  kind?: 'train' | 'eval' | 'test';
  data?: Record<string, unknown>;
}

/** One row read back with its slots' VALUES (`GET example/<id>`). */
export interface DatasetRow extends DatasetRowInput {
  /** The row's own id, stored in the row: it survives a rename and a re-clone. */
  id: string;
  /** How another row points at this one: `<row kind>.id.<id>` — put it in a field typed by that kind. */
  ref: string;
  /** The row's content version: pass it to `put(…, { expected })` so a write never lands over a change it did not see. */
  version: string;
  /** The example folder's name — address the row by it (`put`, `deleteRow`, `rename`, `example`). */
  key: string;
  kind: 'train' | 'eval' | 'test';
  metadata: Record<string, unknown>;
}

/** One thing wrong with a row or a value: where, what kind of problem (`shape:<pydantic type>`,
 *  `dangling_ref`, `inline_row`, `rule`; on a 409 `conflict`, `gone`, `referenced`), and the message
 *  `errors` carries as a line. */
export interface CheckDetail {
  path: string;
  code: string;
  message: string;
  /** `code: "rule"`: the rule broken — both ends (`same`) and why. */
  rule?: { same: [string, string]; description: string };
}

/** A row that does not fit: by key, with everything wrong, its version (to repair it with `put`
 *  and `expected`) and its input as stored, unchecked (null when unreadable). */
export interface DatasetRowProblem {
  /** The row's id and reference — a broken row is still a row: links to it hold. */
  id: string;
  ref: string;
  /** @deprecated the old name of `id` — use `id` / `ref`. */
  example_id: string;
  key: string;
  version: string;
  error: string;
  errors: string[];
  details: CheckDetail[];
  input: unknown;
}

/** A row written by key (`putMany`, `sync`): the row's slots and the key it lands under. */
export type DatasetKeyedRow = Omit<DatasetRowInput, 'key'> & { key: string };

/** Which rows to read: `match` is an expression (`{op, operands}`) or a plain `{path: value}` map
 *  (all must hold); `order_by` is `{path: 'asc' | 'desc'}`, or a list of them (the first wins). */
export interface DatasetRowQuery {
  match?: ExpressionNode | Partial<ExpressionNode> | MatchMap;
  order_by?: OrderByType | OrderByType[];
  limit?: number;
  offset?: number;
}

export interface DatasetRowCount {
  total: number;
  groups: { by: Record<string, unknown>; count: number }[];
}

export interface DatasetSyncResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  deleted: string[];
  num_examples: number;
}

/** The tag a row write emits (`flow_sdk/builtin/dataset.py` `Dataset.ROWS_CHANGED`). */
export const DATASET_ROWS_CHANGED = 'dataset.rows.changed';

/** What `onRowsChanged` hears: which rows moved, never what they hold. */
export interface DatasetRowsChange {
  op: 'put' | 'delete' | 'rename' | 'sync';
  keys: string[];
  count: number;
}

function matchJson(match: NonNullable<DatasetRowQuery['match']>): unknown {
  return match instanceof ExpressionNode ? match.toJSON() : match;
}

/** A row query as the `rows` / `count` actions read it: one `filter` parameter, as JSON — nothing
 *  when the query asks for everything. */
function rowQueryParams(query: DatasetRowQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (query.match && Object.keys(query.match).length) filter.match = matchJson(query.match);
  if (query.order_by) filter.order_by = query.order_by;
  if (query.limit !== undefined) filter.limit = query.limit;
  if (query.offset !== undefined) filter.offset = query.offset;
  return Object.keys(filter).length ? { filter: JSON.stringify(filter) } : {};
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

  /** The kind each row is — its `input` — for a named spec too (`kindForm(specKind).slots.input`);
   *  an inline spec answers here directly. A row is one instance: `<rowKind>.id.<row id>`. */
  get rowKind(): string | null {
    const input = typeof this.spec === 'object' ? this.spec?.examples?.[0]?.input : null;
    return typeof input === 'string' ? input.replace(/^\?/, '') : null;
  }

  /** The reference (`<row kind>.id.<id>`) of this dataset's row with that id — what a link holds. */
  refOf(id: string): string {
    const kind = this.rowKind;
    if (!kind) throw new Error(`dataset ${this.id} names no row kind: its rows cannot be linked to`);
    return `${kind}.id.${id}`;
  }

  /** The row a reference (`<kind>.id.<uuid>`) names among the project's datasets — 404 (thrown) when
   *  none holds it. */
  static async findRow(ref: string, projectId: string): Promise<{ dataset_id: string; key: string; row: DatasetRow }> {
    return apiClient.get(`/api/v1/refs/${encodeURIComponent(ref)}`, { params: { project: projectId } });
  }

  /** The datasets whose rows are `kind`, in `projectId` when given — find them once, by kind. With a
   *  project, `kind` may be the bare name one of its schemas defines (`gtm.icp`). */
  static async forKind(kind: string, projectId?: string): Promise<Dataset[]> {
    const { datasets } = await apiClient.get<{ datasets: Partial<IDataset>[] }>(
      `/api/v1/kinds/${encodeURIComponent(kind)}/datasets`,
      { params: projectId ? { project: projectId } : {} },
    );
    return datasets.map((d) => new Dataset(d));
  }

  /** The rows as the disk holds them: which item each came from, and whether it carries gold.
   *  NOT named `examples`: a dataset read by id carries an `examples` FIELD on the wire, and
   *  assigning it onto the instance hid a method of that name ("examples is not a function"). */
  async listExamples(): Promise<{
    examples: { example_id: string; key: string; item_id: string | null; kind: string; annotated: boolean }[];
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

  /** Every row that fits, with its slots' values, and `problems`: the rows that do not, by key with
   *  all their errors — one bad row never hides the others. With a `query`, only the rows that
   *  match, ordered and paged — `total` is how many matched before paging; `problems` is still
   *  every row that does not fit. A field is a path into the row: `key`, `input.stage`,
   *  `input.stage_dates.won`; a date compares as its ISO string. */
  async rows(query: DatasetRowQuery = {}): Promise<{ rows: DatasetRow[]; total: number; problems: DatasetRowProblem[] }> {
    return this.get('rows', rowQueryParams(query));
  }

  /** How many rows match — and, with `group_by` (field paths), how many per distinct combination
   *  of those fields, largest first. Rows that do not fit their shape are not counted. */
  async count(query: Pick<DatasetRowQuery, 'match'> & { group_by?: string[] } = {}): Promise<DatasetRowCount> {
    const params = rowQueryParams(query);
    if (query.group_by?.length) params.group_by = JSON.stringify(query.group_by);
    return this.get('count', params);
  }

  /** Hear that rows of THIS dataset were written — by this app, another one, or a script — instead
   *  of polling: `handler` gets what happened (`op`), up to 200 of the `keys` that moved and how
   *  many moved in all (`count`) — never the values: re-read the rows you show (`rows(query)`).
   *  One call per write, however many rows it wrote. Best effort (a hint to re-read, not a log):
   *  an event sent while the page was disconnected is not replayed, so still re-read on focus.
   *  Returns the function that stops listening. */
  onRowsChanged(handler: (change: DatasetRowsChange) => void): () => void {
    startTagBridge(); // the server's tags reach this page's bus (idempotent)
    return EventBus.on(DATASET_ROWS_CHANGED, (event) => handler(event.data as unknown as DatasetRowsChange), {
      target: targetOf('dataset', this.id),
    });
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
  /** How one example's answer was reached in a run (its `trace`), fetched only when it is opened. */
  async evalTrace(runId: string, exampleId: string): Promise<EvalTrace | null> {
    const found = (await this.get(`eval/${encodeURIComponent(runId)}/${encodeURIComponent(exampleId)}`)) as { trace?: EvalTrace | null };
    return found?.trace ?? null;
  }

  async runEval(options: { eval?: string; kinds?: string[] } = {}): Promise<EvalRun> {
    return this.post('run-eval', options);
  }

  /** One example with its slots' values — by its key or its id. */
  async example(keyOrId: string): Promise<DatasetRow> {
    return this.get(`example/${encodeURIComponent(keyOrId)}`);
  }

  /** Create the row `key`, or replace the one there. Checked first — a row that does not fit writes
   *  nothing. Slots it leaves out (gold, output, context) and the row's metadata are kept. */
  async put(
    key: string,
    row: Omit<DatasetRowInput, 'key'>,
    options: { expected?: string } = {},
  ): Promise<{ example_id: string; key: string; num_examples: number }> {
    return this.post('put-row', { key, row, ...(options.expected ? { expected: options.expected } : {}) });
  }

  /** Remove one row, by key or id. Refused (409) while another row links to it, and — with
   *  `expected` (the version read) — when the row changed since. */
  async deleteRow(keyOrId: string, options: { expected?: string } = {}): Promise<{ key: string; num_examples: number }> {
    return this.post('delete-row', { key: keyOrId, ...(options.expected ? { expected: options.expected } : {}) });
  }

  /** Create or replace several rows as ONE step — all of them, or none: one row that does not fit
   *  (400, its `details` under `<key>.<path>`) or changed since the version in `expected`
   *  (`{key: version}`; 409) writes nothing. */
  async putMany(
    rows: DatasetKeyedRow[],
    options: { expected?: Record<string, string> } = {},
  ): Promise<{ example_ids: string[]; keys: string[]; num_examples: number }> {
    return this.post('put-rows', { rows, ...(options.expected ? { expected: options.expected } : {}) });
  }

  /** Remove several rows as ONE step — all of them, or none (404 a key that is no row, 409 a row
   *  changed since `expected` or still linked to). Rows removed together do not hold each other back. */
  async deleteRows(
    keys: string[],
    options: { expected?: Record<string, string> } = {},
  ): Promise<{ keys: string[]; num_examples: number }> {
    return this.post('delete-rows', { keys, ...(options.expected ? { expected: options.expected } : {}) });
  }

  /** Make the dataset hold exactly `rows`: new keys created, changed rows replaced, rows that read
   *  the same left untouched, and — unless `prune` is false — rows not listed removed (only those
   *  `match` selects, when given: a writer that owns one slice never removes another's). All or
   *  nothing. */
  async sync(
    rows: DatasetKeyedRow[],
    options: { prune?: boolean; match?: DatasetRowQuery['match'] } = {},
  ): Promise<DatasetSyncResult> {
    return this.post('sync-rows', {
      rows,
      ...(options.prune === undefined ? {} : { prune: options.prune }),
      ...(options.match ? { match: matchJson(options.match) } : {}),
    });
  }

  /** Give a row a new key. Its id stays (stored in the row), so every link to it still holds; a key
   *  copied OUTSIDE Flowpad (a CRM field, a URL) is the one thing that does not follow. With
   *  `expected` (the version read), refused (409) when the row changed since. */
  async rename(keyOrId: string, newKey: string, options: { expected?: string } = {}): Promise<{ example_id: string; key: string }> {
    return this.post('rename-row', { key: keyOrId, new_key: newKey, ...(options.expected ? { expected: options.expected } : {}) });
  }

  /** Would this row fit — its shape, its links and its schema's rules across rows? Nothing is
   *  written. `details` says where and what kind of problem (`code`), all at once. */
  async check(row: Omit<DatasetRowInput, 'key'>): Promise<{ ok: boolean; errors: string[]; details: CheckDetail[] }> {
    return this.post('check-row', { row });
  }

  /** Every row checked against the declared shape; `problems` names the rows that do not fit, by key. */
  async validate(): Promise<{ checked: number; problems: DatasetRowProblem[] }> {
    return this.post('validate', {});
  }

  /** Write one example's gold label (validated against the output shape). */
  async annotate(exampleId: string, groundTruth: unknown): Promise<{ example_id: string; num_annotated: number }> {
    return this.post('annotate', { example_id: exampleId, ground_truth: groundTruth });
  }
}
