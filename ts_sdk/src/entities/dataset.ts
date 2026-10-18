/**
 * Dataset — a folder of rows (flow_sdk/builtin/dataset.py). When bound to a
 * DataSource (`source_id`) its rows are that source's items: `promote` turns
 * items into rows, `annotate` writes a row's gold label.
 */
import { APIEntity, registerEntity } from '../APIEntity';
import type { ApiWarning } from '../ApiResponse';
import apiClient from '../client';
import { IEntity, EntityMerge } from '../IEntity';
import type { EvalRow, EvalRun, EvalTrace } from '../evals/types';
import { ExpressionNode, type MatchMap, type OrderByType } from '../FlowSync/query';
import { EventBus, targetOf } from '../tags/EventBus';
import { startTagBridge } from '../tags/ws-bridge';
import { ConnectionManager } from '../websocket';

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
  rows: [{ input: unknown; output?: unknown; ground_truth?: unknown; context?: unknown }];
}

/** What `spec` holds: the inline form, or the NAME of a registered dataset kind
 *  (`navigator.dataset`, `--acme--.orders.dataset`) — typically one a `data_schema` folder defines. */
export type DatasetSpecForm = DatasetAuthoringSpec | string;

/** One row going in: `input` required, the other slots and the row's role optional. */
export interface DatasetRowInput {
  /** The row's key — its row folder's name (`a-z 0-9 _ -`). Append numbers a row without one. */
  key?: string;
  input: unknown;
  context?: unknown;
  ground_truth?: unknown;
  output?: unknown;
  kind?: 'train' | 'eval' | 'test';
  data?: Record<string, unknown>;
}

/** One row read back with its slots' VALUES (`GET row/<id>`). */
export interface DatasetRow extends DatasetRowInput {
  /** The row's own id, stored in the row: it survives a rename and a re-clone. */
  id: string;
  /** How another row points at this one: `<row kind>.id.<id>` — put it in a field typed by that kind. */
  ref: string;
  /** The row's content version: pass it to `put(…, { expected })` so a write never lands over a change it did not see. */
  version: string;
  /** The row folder's name — address the row by it (`put`, `deleteRow`, `rename`, `row`). */
  key: string;
  kind: 'train' | 'eval' | 'test';
  metadata: Record<string, unknown>;
}

/** One thing wrong with a row or a value: where, what kind of problem (`shape:<pydantic type>`,
 *  `dangling_ref`, `inline_row`, `rule`, `unique`, `owned`; on a 409 `conflict`, `gone`, `referenced`), and the message
 *  `errors` carries as a line. */
export interface CheckDetail {
  path: string;
  code: string;
  message: string;
  /** `code: "rule"` / `"unique"`: the rule broken — both ends (`same`) or the fields no two rows
   *  share (`unique`), and why. */
  rule?: { same?: [string, string]; unique?: string[]; description: string };
  /** `code: "owned"`: the outside system that owns the field (the schema's `owned_by`). */
  owned_by?: string;
}

/** A row that does not fit: by key, with everything wrong, its version (to repair it with `put`
 *  and `expected`) and its input as stored, unchecked (null when unreadable). */
export interface DatasetRowProblem {
  /** The row's id and reference — a broken row is still a row: links to it hold. */
  id: string;
  ref: string;
  /** @deprecated the old name of `id` — use `id` / `ref`. */
  row_id: string;
  key: string;
  version: string;
  error: string;
  errors: string[];
  details: CheckDetail[];
  input: unknown;
}

/** A row written by key (`putMany`, `sync`): the row's slots and the key it lands under. */
export type DatasetKeyedRow = Omit<DatasetRowInput, 'key'> & { key: string };

/** Which rows to read. `match` is an expression (`{op, operands}`) or a plain `{path: value}` map
 *  (all must hold); `q` keeps the rows whose text holds every word of it; `order_by` is
 *  `{path: 'asc' | 'desc'}`, or a list of them (the first wins).
 *
 *  A path is written as a schema's rules write theirs, with the slot spelled out: `key`,
 *  `input.stage`, `input.stage_dates.won`, `input.tags.*` (any element of a list) — and
 *  `input.persona.icp`: a path FOLLOWS a link into the linked row (`input.persona.key` is that
 *  row's key). `expand` names link paths whose rows should come back beside (`linked`). */
export interface DatasetRowQuery {
  match?: ExpressionNode | Partial<ExpressionNode> | MatchMap;
  q?: string;
  order_by?: OrderByType | OrderByType[];
  limit?: number;
  offset?: number;
  expand?: string[];
}

/** The row a link names, as `GET /refs/<ref>` and `rows({expand})` answer it. */
export interface LinkedRow {
  dataset_id: string;
  key: string;
  row: DatasetRow;
}

/** How to count. `group_by` entries are paths (links followed, as in `DatasetRowQuery`) or a date
 *  BUCKET `<day|week|month|quarter>:<path>`, keyed `2026-09-13` (the week's first day),
 *  `2026-09`, `2026-Q3`; `metrics` names further measures `{name: '<distinct|min|max|sum>:<path>'}`;
 *  `order_by` orders the groups by an entry, `count` or a metric's name (else largest first). */
export interface DatasetCountQuery {
  match?: DatasetRowQuery['match'];
  q?: string;
  group_by?: string[];
  metrics?: Record<string, string>;
  order_by?: OrderByType | OrderByType[];
  week_start?: 'monday' | 'sunday';
}

export interface DatasetRowCount {
  total: number;
  /** Present when `metrics` were asked: each measure over every matching row. */
  metrics?: Record<string, unknown>;
  groups: { by: Record<string, unknown>; count: number; metrics?: Record<string, unknown> }[];
}

/** A row that links to another (`usedBy`): the dataset it is in, its kind and its key. */
export interface RowUser {
  dataset_id: string;
  kind: string;
  key: string;
}

/** The period a calendar day falls in, as `count` keys a bucket: `day` `2026-09-13` · `week` the
 *  week's FIRST day · `month` `2026-09` · `quarter` `2026-Q3`. Read from the first ten characters
 *  as written (no time zone); null for a value that is no date. The twin of the server's
 *  `bucket_of`, held to it by `test_fixtures/dataset_count_cases.json` — for an app that labels a
 *  period or asks for one by its key. */
export function bucketOf(
  day: unknown,
  unit: 'day' | 'week' | 'month' | 'quarter',
  weekStart: 'monday' | 'sunday' = 'monday',
): string | null {
  const text = typeof day === 'string' ? day.slice(0, 10) : '';
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!parts) return null;
  const date = new Date(Date.UTC(+parts[1], +parts[2] - 1, +parts[3]));
  if (date.getUTCMonth() !== +parts[2] - 1 || date.getUTCDate() !== +parts[3]) return null; // Feb 30
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (unit === 'day') return iso(date);
  if (unit === 'week') {
    const back = weekStart === 'sunday' ? date.getUTCDay() : (date.getUTCDay() + 6) % 7;
    return iso(new Date(date.getTime() - back * 864e5));
  }
  if (unit === 'month') return text.slice(0, 7);
  return `${parts[1]}-Q${Math.floor((+parts[2] - 1) / 3) + 1}`;
}

export interface DatasetSyncResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  deleted: string[];
  num_rows: number;
  /** `mirror` only: records whose value does not fit the row kind, kept as problem rows (`query().problems`). */
  misfit?: { key: string; details: CheckDetail[] }[];
  /** `mirror` only: link ids no row holds, left out of the row. */
  unlinked?: { key: string; field: string; value: string }[];
}

/** Every row listener's catch-up, run when the socket is back. ONE listener on the connection however
 *  many datasets a page listens to — a page over a dozen datasets is ordinary, and a listener each
 *  trips the connection's listener-count warning. */
const catchUps = new Set<() => void>();
let reconnectHooked = false;
function onReconnected(connection: ConnectionManager, catchUp: () => void): () => void {
  if (!reconnectHooked) {
    reconnectHooked = true;
    connection.on('on_reconnected', () => catchUps.forEach((run) => run()));
  }
  catchUps.add(catchUp);
  return () => void catchUps.delete(catchUp);
}

/** The tag a row write emits (`flow_sdk/builtin/dataset.py` `Dataset.ROWS_CHANGED`). */
export const DATASET_ROWS_CHANGED = 'dataset.rows.changed';

/** What `onRowsChanged` hears: which rows moved, never what they hold. */
export interface DatasetRowsChange {
  op: 'put' | 'delete' | 'rename' | 'sync';
  keys: string[];
  count: number;
  /** The rows as a whole after this write (the same `version` a `query()` read carries); what
   *  `onRowsChanged` compares on reconnect. `sync` with no keys is "something moved while you were
   *  away". */
  version: string;
}

/** Who a write is made for, as the row actions read it. `by` names the outside system the writer
 *  writes as (`"crm"`): only that writer sets a field the schema marks `owned_by` it — anyone else
 *  changing one is refused (400, `details[].code === 'owned'`). An app editing its own fields
 *  leaves it out. A guard against mistakes between cooperating writers, not a permission. */
function writer(options: { by?: string }): { by?: string } {
  return options.by ? { by: options.by } : {};
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
  if (query.expand?.length) filter.expand = query.expand;
  return {
    ...(Object.keys(filter).length ? { filter: JSON.stringify(filter) } : {}),
    ...(query.q?.trim() ? { q: query.q } : {}),
  };
}

export interface IDataset extends IEntity {
  title?: string;
  description?: string | null;
  source_id?: string;
  data_layout?: 'csv' | 'io_folder';
  field_spec?: Record<string, string>;
  delimiter?: string;
  spec?: DatasetSpecForm | null;
  num_rows?: number;
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
  num_rows: number = 0;
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
    this.num_rows = entity.num_rows ?? this.num_rows;
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
      spec: { rows: [{ input: 'ingest.source_item', output }] },
    });
  }

  /** The output shape of one row, in authoring form (`{field: kind}`), or null — null too when
   *  `spec` NAMES a kind: that shape lives in the kind (see `GET /api/v1/kinds/<kind>`). */
  get outputShape(): unknown {
    return typeof this.spec === 'string' ? null : (this.spec?.rows?.[0]?.output ?? null);
  }

  /** The registered kind every row is, when `spec` names one; else null. */
  get specKind(): string | null {
    return typeof this.spec === 'string' ? this.spec : null;
  }

  /** The kind each row is — its `input` — for a named spec too (`kindForm(specKind).slots.input`);
   *  an inline spec answers here directly. A row is one instance: `<rowKind>.id.<row id>`. */
  get rowKind(): string | null {
    const input = typeof this.spec === 'object' ? this.spec?.rows?.[0]?.input : null;
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
  static async findRow(ref: string, projectId: string): Promise<LinkedRow> {
    return apiClient.get(`/api/v1/refs/${encodeURIComponent(ref)}`, { params: { project: projectId } });
  }

  /** The datasets whose rows are `kind`, in `projectId` when given — find them once, by kind. With a
   *  project, `kind` may be the bare name one of its schemas defines (`crm.lead`). */
  static async forKind(kind: string, projectId?: string): Promise<Dataset[]> {
    const { datasets } = await apiClient.get<{ datasets: Partial<IDataset>[] }>(
      `/api/v1/kinds/${encodeURIComponent(kind)}/datasets`,
      { params: projectId ? { project: projectId } : {} },
    );
    return datasets.map((d) => new Dataset(d));
  }

  /** The rows as the disk holds them: which item each came from, and whether it carries gold.
   *  NOT named `rows`: a dataset read by id carries a `rows` FIELD on the wire, and assigning it
   *  onto the instance would hide a method of that name (why the read is `query`). */
  async rowIndex(): Promise<{
    rows: { row_id: string; key: string; item_id: string | null; kind: string; annotated: boolean }[];
  }> {
    return this.get('row-index');
  }

  /** Items → rows. Returns the new row ids. */
  async promote(sourceItemIds: string[]): Promise<{ ids: string[]; num_rows: number }> {
    return this.post('promote', { source_item_ids: sourceItemIds });
  }

  /** Typed rows in — each checked against the declared shape; one bad row writes nothing. In a mirrored
   *  dataset a record the outside system made but not all of is still written, with `warnings`
   *  (`source_partial`) saying what was not set. */
  async append(
    rows: DatasetRowInput[],
    options: { by?: string } = {},
  ): Promise<{ ids: string[]; num_rows: number; warnings?: ApiWarning[] }> {
    return this.post('append', { rows, ...writer(options) });
  }

  /** Every row that fits, with its slots' values, and `problems`: the rows that do not, by key with
   *  all their errors — one bad row never hides the others. With a `query`, only the rows that
   *  match, ordered and paged — `total` is how many matched before paging; `problems` is still
   *  every row that does not fit. A field is a path into the row: `key`, `input.stage`,
   *  `input.stage_dates.won`; a date compares as its ISO string. */
  async query(
    query: DatasetRowQuery = {},
  ): Promise<{ rows: DatasetRow[]; total: number; problems: DatasetRowProblem[]; linked?: Record<string, LinkedRow>; version: string }> {
    const found = await this.get<{ rows: DatasetRow[]; total: number; problems: DatasetRowProblem[]; linked?: Record<string, LinkedRow>; version: string }>(
      'rows',
      rowQueryParams(query),
    );
    this.rowsRead = found.version; // a read is a sighting too (`onRowsChanged`)
    return found;
  }

  /** The rows version the last `query()` on this instance read — so a listener on it never asks the
   *  page to re-read what it just read, whichever came first, the read or the subscription. */
  private rowsRead?: string;

  /** How many rows match — the SAME `match` and `q` as `rows`, so a number and the list behind it
   *  are one question — and, with `group_by`, how many per distinct combination (a path, or a date
   *  bucket `week:input.day`), with `metrics` (`distinct:` / `min:` / `max:` / `sum:`) overall and
   *  per group. Rows that do not fit their shape are not counted. */
  async count(query: DatasetCountQuery = {}): Promise<DatasetRowCount> {
    const params = rowQueryParams({ match: query.match, q: query.q });
    if (query.group_by?.length) params.group_by = JSON.stringify(query.group_by);
    if (query.metrics && Object.keys(query.metrics).length) params.metrics = JSON.stringify(query.metrics);
    if (query.order_by) params.order_by = JSON.stringify(query.order_by);
    if (query.week_start) params.week_start = query.week_start;
    return this.get('count', params);
  }

  /** Who links to each row: `{key: [{dataset_id, kind, key}]}` for `keys` (every row when left
   *  out) — `[]` for a row nothing links to. What a delete is refused for, asked ahead of time. */
  async usedBy(keys?: string[]): Promise<Record<string, RowUser[]>> {
    const found = await this.get<{ used_by: Record<string, RowUser[]> }>('used-by', keys?.length ? { keys: keys.join(',') } : {});
    return found.used_by;
  }

  /** Hear that rows of THIS dataset were written — by this app, another one, or a script — instead
   *  of polling: `handler` gets what happened (`op`), up to 100 of the `keys` that moved and how
   *  many moved in all (`count`) — never the values: re-read the rows you show (`rows(query)`).
   *  One call per write, however many rows it wrote. The event is enough — no timer, no re-read on
   *  focus: a write made while the socket was down is told once it is back, as `{op: 'sync',
   *  keys: [], count: 0, version}` — the rows' version moved past the last one this listener heard
   *  or this instance read. Returns the function that stops listening. */
  onRowsChanged(handler: (change: DatasetRowsChange) => void): () => void {
    // The server's tags reach this page's bus over the socket. A served app's `initSdk()` does not
    // open one (only the full UI does, after paint), so listening opens it — both are idempotent,
    // and a socket that cannot open is not an error here: it is retried, and the catch-up below
    // runs once it opens.
    startTagBridge();
    const connection = ConnectionManager.getInstance();
    void connection.connect().catch(() => undefined);
    // The last version THIS listener heard — its own, so two views on one dataset each catch up.
    let heard: string | undefined;
    const offTag = EventBus.on(
      DATASET_ROWS_CHANGED,
      (event) => {
        const change = event.data as unknown as DatasetRowsChange;
        heard = change.version;
        handler(change);
      },
      { target: targetOf('dataset', this.id) },
    );
    // What was missed while the socket was down: one small read, and a `sync` only when the version
    // is one neither this listener heard nor this instance read. The first check is the baseline.
    const catchUp = async () => {
      let version: string;
      try {
        ({ version } = await this.get<{ version: string }>('rows-version'));
      } catch {
        return; // the server is away: the next reconnect asks again
      }
      const known = heard ?? this.rowsRead;
      const moved = known !== undefined && version !== heard && version !== this.rowsRead;
      heard = version;
      if (moved) handler({ op: 'sync', keys: [], count: 0, version });
    };
    void catchUp();
    const offReconnect = onReconnected(connection, catchUp);
    return () => {
      offTag();
      offReconnect();
    };
  }

  /** Every eval run on this dataset, newest first (summaries — no slices). */
  async evalRuns(): Promise<{ runs: EvalRun[]; count_metrics: string[]; explain: Record<string, Record<string, string>> }> {
    return this.get('evals');
  }

  /** One eval run: the run and every evaluated row, joined to its input / context / data. */
  async evalRun(runId: string): Promise<{ run: EvalRun; rows: EvalRow[]; count_metrics: string[]; explain: Record<string, string> }> {
    return this.get(`eval/${encodeURIComponent(runId)}`);
  }

  /** Run this dataset's eval now; answers the new run. */
  /** How one row's answer was reached in a run (its `trace`), fetched only when it is opened. */
  async evalTrace(runId: string, rowId: string): Promise<EvalTrace | null> {
    const found = (await this.get(`eval/${encodeURIComponent(runId)}/${encodeURIComponent(rowId)}`)) as { trace?: EvalTrace | null };
    return found?.trace ?? null;
  }

  async runEval(options: { eval?: string; kinds?: string[] } = {}): Promise<EvalRun> {
    return this.post('run-eval', options);
  }

  /** One row with its slots' values — by its key or its id. */
  async row(keyOrId: string): Promise<DatasetRow> {
    return this.get(`row/${encodeURIComponent(keyOrId)}`);
  }

  /** Create the row `key`, or replace the one there. Checked first — a row that does not fit writes
   *  nothing. Slots it leaves out (gold, output, context) and the row's metadata are kept. In a dataset
   *  a data source mirrors into, the fields its system owns go to that system first (refused as
   *  `source_refused`, or `not_writable` for one that cannot go back), and a new row takes its record's
   *  key — the `key` answered is the row's. */
  async put(
    key: string,
    row: Omit<DatasetRowInput, 'key'>,
    options: { expected?: string; by?: string } = {},
  ): Promise<{ row_id: string; key: string; num_rows: number; warnings?: ApiWarning[] }> {
    return this.post('put-row', { key, row, ...(options.expected ? { expected: options.expected } : {}), ...writer(options) });
  }

  /** Remove one row, by key or id. Refused (409) while another row links to it, and — with
   *  `expected` (the version read) — when the row changed since. */
  async deleteRow(keyOrId: string, options: { expected?: string } = {}): Promise<{ key: string; num_rows: number }> {
    return this.post('delete-row', { key: keyOrId, ...(options.expected ? { expected: options.expected } : {}) });
  }

  /** Create or replace several rows as ONE step — all of them, or none: one row that does not fit
   *  (400, its `details` under `<key>.<path>`) or changed since the version in `expected`
   *  (`{key: version}`; 409) writes nothing. */
  async putMany(
    rows: DatasetKeyedRow[],
    options: { expected?: Record<string, string>; by?: string } = {},
  ): Promise<{ ids: string[]; keys: string[]; num_rows: number; warnings?: ApiWarning[] }> {
    return this.post('put-rows', { rows, ...(options.expected ? { expected: options.expected } : {}), ...writer(options) });
  }

  /** Remove several rows as ONE step — all of them, or none (404 a key that is no row, 409 a row
   *  changed since `expected` or still linked to). Rows removed together do not hold each other back. */
  async deleteRows(
    keys: string[],
    options: { expected?: Record<string, string> } = {},
  ): Promise<{ keys: string[]; num_rows: number }> {
    return this.post('delete-rows', { keys, ...(options.expected ? { expected: options.expected } : {}) });
  }

  /** Make the dataset hold exactly `rows`: new keys created, changed rows replaced, rows that read
   *  the same left untouched, and — unless `prune` is false — rows not listed removed (only those
   *  `match` selects, when given: a writer that owns one slice never removes another's). All or
   *  nothing. */
  async sync(
    rows: DatasetKeyedRow[],
    options: { prune?: boolean; match?: DatasetRowQuery['match']; by?: string } = {},
  ): Promise<DatasetSyncResult> {
    return this.post('sync-rows', {
      rows,
      ...(options.prune === undefined ? {} : { prune: options.prune }),
      ...(options.match ? { match: matchJson(options.match) } : {}),
      ...writer(options),
    });
  }

  /** Give a row a new key. Its id stays (stored in the row), so every link to it still holds; a key
   *  copied OUTSIDE Flowpad (a CRM field, a URL) is the one thing that does not follow. With
   *  `expected` (the version read), refused (409) when the row changed since. */
  async rename(keyOrId: string, newKey: string, options: { expected?: string } = {}): Promise<{ row_id: string; key: string }> {
    return this.post('rename-row', { key: keyOrId, new_key: newKey, ...(options.expected ? { expected: options.expected } : {}) });
  }

  /** Make this dataset the typed MIRROR of a data source: each of the source's items becomes one
   *  row of this dataset's kind, and the dataset is made to hold exactly those (as `sync`). `map`
   *  says how an item becomes a row, in the path grammar — `{key: 'external_id', input: {name:
   *  'name', stage: 'data.stage'}}` (`{value: x}` is a constant). `by` is the outside system the
   *  rows are written as (default: the source's provider). */
  async mirror(
    sourceId: string,
    map: { key: string; input: Record<string, unknown> },
    options: { by?: string; prune?: boolean; match?: DatasetRowQuery['match'] } = {},
  ): Promise<DatasetSyncResult> {
    return this.post('mirror', {
      source_id: sourceId,
      map,
      ...writer(options),
      ...(options.prune === undefined ? {} : { prune: options.prune }),
      ...(options.match ? { match: matchJson(options.match) } : {}),
    });
  }

  /** Would this row fit — its shape, its links, its schema's rules across rows (a `unique` value
   *  another row holds), and the fields an outside system owns? Nothing is written. A row that
   *  carries its `key` is checked as a `put` of that row would be; one without, as a new row.
   *  `details` says where and what kind of problem (`code`), all at once. */
  async check(
    row: DatasetRowInput,
    options: { by?: string } = {},
  ): Promise<{ ok: boolean; errors: string[]; details: CheckDetail[] }> {
    return this.post('check-row', { row, ...writer(options) });
  }

  /** Every row checked against the declared shape; `problems` names the rows that do not fit, by key. */
  async validate(): Promise<{ checked: number; problems: DatasetRowProblem[] }> {
    return this.post('validate', {});
  }

  /** Write one row's gold label (validated against the output shape). */
  async annotate(rowId: string, groundTruth: unknown): Promise<{ row_id: string; num_annotated: number }> {
    return this.post('annotate', { row_id: rowId, ground_truth: groundTruth });
  }
}
