/**
 * `ConnectionSpec` — one connection, whatever kind it is.
 *
 * The TypeScript mirror of the backend `DataSpec`
 * (`flow_sdk/core/connections/types.py`), maintained by hand 1:1, the same way
 * `llm-source.ts` mirrors `LLMSource`.
 *
 * The screen used to fold four separate fetches itself, which put the definition
 * of "connected" in the browser and let two surfaces disagree about the same
 * credential. The backend composes the list now; this is the shape it sends.
 */

/** What KIND of thing a connection is — four different credential lifetimes. */
export enum ConnectionKind {
  /** A provider grant, refreshed against that provider. */
  OAuth = 'oauth',
  /** Env-var values in one project's environment. Project-scoped. */
  ApiKey = 'api_key',
  /** This instance's own hub account. */
  Flowpad = 'flowpad',
  /** A vendor CLI's own session — only that CLI can spend it. */
  Harness = 'harness',
}

/**
 * What can be said about it right now.
 *
 * `Unknown` is a real answer, not a hedge: a harness login's state lives on a
 * non-persisted field, so "nobody has asked" is the normal reading after a
 * restart and must never be rendered as "not connected".
 */
export enum ConnectionState {
  Connected = 'connected',
  Disconnected = 'disconnected',
  NeedsReauth = 'needs_reauth',
  Unknown = 'unknown',
}

export interface ConnectionSpec {
  /** The id WITHIN its kind: a provider name, a credential definition's name,
   *  `flowpad`, or a worker type. */
  provider: string;
  display_name: string;
  kind: ConnectionKind;
  state: ConnectionState;
  /** Coarser than `state`; kept because the SDK and CLI both read it. */
  connected: boolean;
  /** The resolver's own sentence. Render it verbatim — the backend is the only
   *  side that knows why, and rewriting it here is how a status starts lying. */
  detail: string;
  identity: string;
  icon: string;
  /** `machine` or `project`. Only API-key credentials are project-scoped. */
  scope: string;
  credential_ref: string;
  /** OAuth scopes the grant asks for. */
  scopes: string[];
  /** The env vars an API-key credential is made of. Names only, never values. */
  env_vars: string[];
}
