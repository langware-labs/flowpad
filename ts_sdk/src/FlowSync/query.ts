import { ExpansionType } from './expand';
import { TypeId } from '../models/TypeId';

export type QueryOp =
  | '$OR'
  | '$AND'
  | '$EQ'
  | '$NE'
  | '$GT'
  | '$GE'
  | '$LT'
  | '$LE'
  | '$IN'
  | '$NIN'
  | '$LIKE'
  | '$IS_NULL'
  | '$IS_NOT_NULL'
  | '$PROP';

/** Several values at one path (a `*` step): a test passes when any of them does. */
export class Many extends Array<any> {}

/**
 * The value at `path` in `data` — ONE path grammar, the Python twin of
 * `flow_sdk.datasets.query.field_of` (held together by `test_fixtures/dataset_query_cases.json`):
 * the key as written when the object has it, else walked dot by dot (`input.stage_dates.won`); a
 * list is stepped into by index (`input.steps.0`), and `*` is every element of a list
 * (`input.tags.*`) — the path then has several values (`Many`). `undefined` when the path leads
 * nowhere. A link is NOT followed here (`input.persona.icp`): the rows it leads to are on the
 * server, which is where a row query is answered.
 */
export function fieldOf(data: any, path: unknown): any {
  if (data == null || typeof path !== 'string') return undefined;
  if (typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, path)) return data[path];
  let current: any[] = [data];
  let many = false;
  for (const step of path.split('.')) {
    if (step === '*') {
      many = true;
      current = current.flatMap((at) => (Array.isArray(at) ? at : []));
    } else {
      current = current.map((at) => {
        if (Array.isArray(at)) return /^\d+$/.test(step) ? at[Number(step)] : undefined; // an index, never a property
        return at != null && typeof at === 'object' ? at[step] : undefined;
      });
    }
    if (!current.length) break;
  }
  if (many) return Many.from(current.filter((v) => v != null)) as Many;
  return current.length ? current[0] : undefined;
}

/** The values a test is tried against: each of a `Many`, else the one. */
function valuesOf(value: any): any[] {
  return value instanceof Many ? [...value] : [value];
}

export class ExpressionNode {
  // IS_NULL/IS_NOT_NULL are unary: canonical leaf shape is ``operands:
  // [field]`` — a trailing ``null`` would be DROPPED by axios GET param
  // serialization. ``null`` stays admitted so the legacy two-operand form
  // still type-checks (mirrors the py model).
  operands: (ExpressionNode | string | number | null | Partial<ExpressionNode>)[];
  op?: QueryOp;

  constructor(data: any) {
    if (!data.operands) {
      const keys = Object.keys(data);
      if (keys.length === 1) {
        // Single-key plain map → leaf $EQ with [key, value] operands.
        const objectKey = keys[0];
        this.operands = [objectKey, data[objectKey]];
      } else {
        // Multi-key plain map → $AND of $EQ children. Each {k:v} pair
        // must itself be an ExpressionNode so `validateExpressionNode`'s
        // recursion lands on a node with a real `op` instead of reading
        // `op` off a plain object and throwing "Unsupported operation:
        // undefined" on every WS data_op_msg fan-out.
        this.operands = keys.map((key) => new ExpressionNode({ [key]: data[key] }));
        data = { operands: this.operands, op: '$AND' };
      }
    } else {
      // Pre-shaped operands path (e.g. an explicit `{op, operands}` value
      // or a deserialized filter). Wrap any plain-object operands so the
      // tree is uniformly ExpressionNode-or-primitive-leaf — no half-typed
      // nodes that pass `instanceof` casts but lack `op`/`operands`.
      this.operands = data.operands.map((operand: any) => {
        if (operand instanceof ExpressionNode) return operand;
        // A literal value-list operand (e.g. the id array of an ``$IN`` /
        // ``$NIN`` leaf) is NOT a sub-expression — it must pass through
        // unchanged. Without this guard ``typeof [] === 'object'`` sent the
        // array down the plain-map branch, where ``Object.keys`` turned its
        // indices into a bogus nested ``$AND``/``$EQ`` tree and the backend
        // ``ids`` filter silently matched everything.
        if (Array.isArray(operand)) return operand;
        if (typeof operand !== 'object' || operand === null) return operand;
        return new ExpressionNode(operand);
      });
    }
    this.op = data.op || '$EQ';
  }

  toJSON(): object {
    const operands = this.operands;
    for (let i = 0; i < operands.length; i++) {
      if (operands[i] instanceof ExpressionNode) {
        operands[i] = (operands[i] as ExpressionNode).toJSON();
      }
    }
    return {
      op: this.op,
      operands: operands,
    };
  }
}

export class ExpansionRequest {
  expand?: ExpansionType[];
  load?: boolean;

  constructor(data?: Partial<ExpansionRequest>) {
    if (data) {
      this.expand = data.expand;
      this.load = data.load;
    }
  }

  get expandString(): string | undefined {
    return this.expand ? this.expand.join(',') : undefined;
  }

  toJSON(): object {
    return {
      expand: this.expandString,
    };
  }
}

export type OrderByType = Record<string, 'asc' | 'desc'>;

/**
 * A plain field→value map — the `ExpressionNode` constructor's second, and by
 * far most common, input form: one key becomes an `$EQ` leaf, several become an
 * `$AND` of `$EQ` leaves. Not an `ExpressionNode` shape at all, which is why
 * `QueryFilter.match` has to admit it separately.
 */
export type MatchMap = Record<string, string | number | boolean | null>;

export class QueryFilter extends ExpansionRequest {
  type?: string;
  match?: ExpressionNode | Partial<ExpressionNode> | MatchMap;
  limit?: number;
  offset?: number;
  order_by?: OrderByType | OrderByType[];

  constructor(data: Partial<QueryFilter>) {
    if (data) {
      super(data);
      this.type = data.type?.toLowerCase();
      if (typeof data.match === 'object') {
        this.match = new ExpressionNode(data.match);
      } else {
        this.match = data.match;
      }
      this.limit = data.limit;
      this.offset = data.offset;
      this.order_by = data.order_by;
    }
  }

  static parse(filterJson: object, entityType: string): QueryFilter {
    try {
      let data: any = filterJson;
      if (data.filter) {
        data = { ...data, ...data.filter };
        delete data.filter;
      }
      // A map without `match` is the match itself (`{status: 'open'}`) — unless every key is a
      // filter word: `{limit: 3}` is a page of three, never "the rows whose limit is 3".
      const words = ['limit', 'offset', 'order_by', 'expand'];
      const keys = Object.keys(data);
      if (!data.match && keys.length > 0 && !data.expand && !keys.every((key) => words.includes(key))) {
        data = { match: data, type: entityType };
      }
      data = { ...data, type: entityType };
      if (data.expand && typeof data.expand === 'string') {
        data.expand = data.expand.split(',');
      }
      return new QueryFilter(data);
    } catch (e: any) {
      if (e instanceof SyntaxError) {
        throw new Error(`Invalid query filter JSON: ${e.message}`);
      } else {
        throw new Error(`Validation error: ${e.message}`);
      }
    }
  }

  toJSON(): object {
    let match: ExpressionNode | object | undefined = this.match;
    if (match instanceof ExpressionNode) {
      match = match.toJSON();
    }
    return {
      filter: match ? { match: match } : undefined,
      limit: this.limit,
      offset: this.offset,
      order_by: this.order_by,
      expand: this.expandString,
    };
  }
  // Validate the data for whether it passes the filter
  validate(data: any): boolean {
    if (!this.match) {
      return true; // If no match condition is specified, assume all data passes
    }

    const condition = this.match;

    if (condition instanceof ExpressionNode) {
      // Validate based on the ExpressionNode
      return this.validateExpressionNode(condition, data);
    } else if (typeof condition === 'object') {
      // Validate based on a simple object
      return this.validateObject(condition, data);
    } else {
      throw new Error('Invalid match type');
    }
  }

  private validateExpressionNode(condition: ExpressionNode, data: any): boolean {
    // Extract the operation and operands from the ExpressionNode
    const { op, operands } = condition;

    switch (op) {
      case '$AND':
        // For AND, all conditions in operands must be true
        return operands.every((operand) => this.validateExpressionNode(operand as ExpressionNode, data));
      case '$OR':
        // For OR, at least one condition in operands must be true
        return operands.some((operand) => this.validateExpressionNode(operand as ExpressionNode, data));
      case '$EQ': {
        const greaterThanOperator = (a: any, b: any) => a === b;
        return this.isValid(data, operands, greaterThanOperator);
      }
      case '$NE': {
        const greaterThanOperator = (a: any, b: any) => a !== b;
        return this.isValid(data, operands, greaterThanOperator, false, true);
      }
      case '$GT': {
        const greaterThanOperator = (a: any, b: any) => a > b;
        return this.isValid(data, operands, greaterThanOperator);
      }
      case '$GE': {
        const greaterThanOperator = (a: any, b: any) => a >= b;
        return this.isValid(data, operands, greaterThanOperator);
      }
      case '$LT': {
        const greaterThanOperator = (a: any, b: any) => a < b;
        return this.isValid(data, operands, greaterThanOperator);
      }
      case '$LE': {
        const greaterThanOperator = (a: any, b: any) => a <= b;
        return this.isValid(data, operands, greaterThanOperator);
      }
      case '$IN':
      case '$NIN': {
        // Two shapes. The backend's own — ``[field, [values]]``, "the field is one of these" (a
        // batch by ids) — must re-check the same way here, or every update of a row in such a live
        // query splices it OUT of the results (the Vibe help button lost its unread count that way).
        // The older ``[value, {$PROP: field}]`` — "this array field contains the value" — is kept.
        if (Array.isArray(operands[1])) {
          const hit = valuesOf(fieldOf(data, operands[0])).some((v) => (operands[1] as unknown[]).includes(v));
          return op === '$IN' ? hit : !hit;
        }
        // a field that is no list holds nothing: neither `in` nor `not in` passes (as the Python twin)
        const contains = (a: any, b: any) =>
          (Array.isArray(a) || typeof a === 'string') && (op === '$IN' ? a.includes(b) : !a.includes(b));
        return this.isValid(data, operands, contains, true);
      }
      case '$LIKE': {
        // Mirror the SQL driver's ``field LIKE %value%``: case-insensitive
        // substring of the FIELD value. (Was a regex built from the field and
        // tested against the query — backwards, and regex metachars in either
        // side could throw or mismatch live data_op re-validation vs SQL.)
        // On a list field: ANY element contains it (never the list's printed form).
        const like = (a: any, b: any): boolean =>
          Array.isArray(a)
            ? a.some((item) => like(item, b))
            : String(a ?? '')
                .toLowerCase()
                .includes(String(b ?? '').toLowerCase());
        return this.isValid(data, operands, like);
      }
      // Loose null-check on purpose: an unset field is `undefined` on the
      // cached entity but NULL in the DB — both must match $IS_NULL.
      case '$IS_NULL':
        return valuesOf(fieldOf(data, operands[0])).every((v) => v == null);
      case '$IS_NOT_NULL':
        return valuesOf(fieldOf(data, operands[0])).some((v) => v != null);
      default:
        throw new Error(`Unsupported operation: ${op}`);
    }
  }

  private validateObject(condition: { [key: string]: any }, data: any): boolean {
    for (const key in condition) {
      if (condition.hasOwnProperty(key)) {
        if (data[key] !== condition[key]) {
          return false;
        }
      }
    }
    return true;
  }

  // The helper method that checks the validity based on operands and the operator
  private isValid(
    data: any,
    operands: any[],
    operand: (a: any, b: any) => boolean,
    mustContainsPROP: boolean = false,
    everyValue: boolean = false,
  ): boolean {
    // A path over a list (`*`) has several values: a test passes when ANY does — and "is not X"
    // (`everyValue`) when none of them is.
    const over = (held: any, wanted: any): boolean => {
      if (!(held instanceof Many)) return operand(held, wanted);
      return everyValue ? held.every((v) => operand(v, wanted)) : held.some((v) => operand(v, wanted));
    };
    if (!data || typeof data !== 'object') {
      return false;
    }
    if (operands.length === 2) {
      // In case of two operands: [field, valuesArray or PROP]
      if (operands[1].op && operands[1].op === '$PROP') {
        // If the second operand is a PROP operation, assume it's a field
        const field = operands[1].operands[0];
        return over(fieldOf(data, field), operands[0]);
      } else {
        if (mustContainsPROP) {
          return false;
        }
        // Otherwise, compare the field directly with the value in the second operand
        return over(fieldOf(data, operands[0]), operands[1]);
      }
    } else {
      return false; // If there are not exactly 2 operands, return false
    }
  }
}

/**
 * Represents a callback with metadata
 */
export class QueryCallback<T = any> {
  private static callbackCounter = 0;

  public readonly name: string;
  public readonly callback: (entities: T[]) => void | Promise<void>;

  constructor(data: { callback: (entities: T[]) => void | Promise<void>; name?: string }) {
    this.callback = data.callback;

    // Auto-generate name if not provided
    if (data.name) {
      this.name = data.name;
    } else {
      QueryCallback.callbackCounter++;
      this.name = `callback ${QueryCallback.callbackCounter}`;
    }
  }

  /**
   * Invoke the callback with results
   */
  invoke(results: T[]): void {
    void this.callback(results);
  }
}

/**
 * Represents a watched query with its request, callbacks, and cached results
 */
export class WatchedQuery<T = any> {
  private static instanceCounter = 0;

  public readonly instance_id: number;
  public readonly request: QueryRequest;
  public results?: T[];
  public pendingPromise?: Promise<T[]>;
  private callbacks: Map<string, QueryCallback<T>>;

  /**
   * `subscribe: false` builds an in-flight record: it carries the request's
   * promise and results but subscribes nobody, whatever callback the request has.
   */
  constructor(
    request: QueryRequest,
    results?: T[],
    pendingPromise?: Promise<T[]>,
    { subscribe = true }: { subscribe?: boolean } = {},
  ) {
    WatchedQuery.instanceCounter++;
    this.instance_id = WatchedQuery.instanceCounter;
    this.request = request;
    this.results = results;
    this.pendingPromise = pendingPromise;
    this.callbacks = new Map();

    // Add the initial callback from the request if it exists
    if (subscribe && request.callback) {
      const queryCallback = new QueryCallback({
        callback: request.callback as (entities: T[]) => void | Promise<void>,
        name: request.name,
      });
      this.callbacks.set(queryCallback.name, queryCallback);
    }
  }

  /**
   * Add a callback to be notified when results change
   */
  addCallback(callback: (entities: T[]) => void | Promise<void>, name?: string): () => void {
    const queryCallback = new QueryCallback({ callback, name });
    this.callbacks.set(queryCallback.name, queryCallback);

    // Return unsubscribe function
    return () => {
      this.callbacks.delete(queryCallback.name);
    };
  }

  /**
   * Remove a specific callback by function reference
   */
  removeCallback(callback: (entities: T[]) => void | Promise<void>): boolean {
    // Find the QueryCallback with matching function
    for (const [name, queryCallback] of this.callbacks.entries()) {
      if (queryCallback.callback === callback) {
        return this.callbacks.delete(name);
      }
    }
    return false;
  }

  /**
   * Get all registered callbacks (for backward compatibility)
   */
  getCallbacks(): Set<(entities: T[]) => void | Promise<void>> {
    const callbackSet = new Set<(entities: T[]) => void | Promise<void>>();
    for (const queryCallback of this.callbacks.values()) {
      callbackSet.add(queryCallback.callback);
    }
    return callbackSet;
  }

  /**
   * Get all QueryCallback objects
   */
  getQueryCallbacks(): QueryCallback<T>[] {
    return Array.from(this.callbacks.values());
  }

  /**
   * Check if there are any callbacks registered
   */
  hasCallbacks(): boolean {
    return this.callbacks.size > 0;
  }

  /**
   * Update results and notify all callbacks
   */
  updateResults(newResults: T[]): void {
    this.results = newResults;
    this.notifyCallbacks();
  }

  /**
   * Notify all callbacks with current results
   */
  notifyCallbacks(): void {
    if (this.results) {
      this.callbacks.forEach((queryCallback) => {
        queryCallback.invoke(this.results!);
      });
    } else {
      // Handle other cases if needed
    }
  }

  /**
   * Get the unique key for this watched query
   */
  get key(): string {
    return `${this.request.type}:${this.request.queryKey}:${this.request.scopeKey}`;
  }
}

export class QueryRequest {
  private static queryCounter = 0;

  public readonly name: string;
  public readonly type: string;
  public readonly query: QueryFilter | null;
  public readonly scope: TypeId[];
  public readonly callback?: (entities: any[]) => void | Promise<void>;

  constructor(data: {
    type: string;
    query?: QueryFilter | null | object;
    scope?: TypeId[];
    callback?: (entities: any[]) => void | Promise<void>;
    name?: string;
  }) {
    // A key this constructor does not read was silently dropped — `new QueryRequest({type, limit: 3})`
    // asked for everything. Paging and matching belong in `query` (a `QueryFilter`).
    const unknown = Object.keys(data).filter((key) => !['type', 'query', 'scope', 'callback', 'name'].includes(key));
    if (unknown.length) {
      throw new Error(
        `QueryRequest: unknown ${unknown.map((k) => `'${k}'`).join(', ')} — put match / limit / offset / order_by in \`query\` (new QueryFilter({...}))`,
      );
    }
    this.type = data.type;
    this.query =
      data.query && !(data.query instanceof QueryFilter)
        ? QueryFilter.parse(data.query, data.type)
        : (data.query as QueryFilter | null) || null;
    this.scope = data.scope || [];
    this.callback = data.callback;

    // Auto-generate name if not provided
    if (data.name) {
      this.name = data.name;
    } else {
      QueryRequest.queryCounter++;
      this.name = `query ${QueryRequest.queryCounter}`;
    }
  }

  /**
   * Get the query key used for matching and caching queries
   */
  get queryKey(): string {
    return JSON.stringify(this.query || {});
  }

  /**
   * Get the scope key used for matching and caching queries
   */
  get scopeKey(): string {
    return JSON.stringify(this.scope.map((tid) => tid.toString()));
  }

  /**
   * Get the unique key for this query request (combines type, queryKey, and scopeKey)
   */
  get key(): string {
    return `${this.type}:${this.queryKey}:${this.scopeKey}`;
  }

  toJSON(): object {
    return {
      name: this.name,
      type: this.type,
      query: this.query ? this.query.toJSON() : null,
      scope: this.scope.map((s) => s.toString()),
    };
  }
}
