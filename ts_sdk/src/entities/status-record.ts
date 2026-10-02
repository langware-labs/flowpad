/**
 * The status record — WHAT is on this box, before anyone asks what pays.
 *
 * Hand-maintained mirror of `flow_sdk/schema/data_spec/status_spec.py` (`StatusSpec` and friends), pinned
 * by `tests/unit/test_status_ts_parity.py`. The UI renders these facts and derives none of
 * them: installed, signed in, which keys are stored and whether FlowPad is signed in each have
 * exactly one writer, in Python. Funding (`LLMFundingStatus`) is a layer on top.
 */

/** Is the harness's CLI on this machine. */
export enum InstallState {
  Installed = 'installed',
  NotInstalled = 'not_installed',
  /** A `python -m` harness that ships with Flowpad: nothing to install. */
  BuiltIn = 'built_in',
  /** The discovery sweep has not finished yet. */
  Unknown = 'unknown',
}

/** The harness's OWN login — never inferred from what funds it. */
export enum LoginState {
  SignedIn = 'signed_in',
  SignedOut = 'signed_out',
  Error = 'error',
  SigningIn = 'signing_in',
  /** Installed, and no probe has decided yet. Never presumed to be signed in. */
  NotChecked = 'not_checked',
  /** No login to have: the CLI is not installed, or the harness has no account of its own. */
  NA = 'n_a',
}

/** This box's FlowPad account, from the hub's own answer to "who am I". */
export enum HubLogin {
  SignedIn = 'signed_in',
  SignedOut = 'signed_out',
  SigningIn = 'signing_in',
  Rejected = 'rejected',
  Offline = 'offline',
}

export interface StatusAccount {
  identity: string;
  plan: string;
}

export interface HarnessStatus {
  /** Capability kind (`harness.claude.cli`) — the key every other record uses. */
  kind: string;
  /** Driver name (`claude`). */
  worker_type: string;
  label: string;
  icon: string;
  install: InstallState;
  version: string;
  path: string;
  login: LoginState;
  login_checked_at: string;
  login_message: string;
  account: StatusAccount;
  has_device_login: boolean;
  key_providers: string[];
  install_command: string;
  homepage_url: string;
}

export interface KeyStatus {
  provider: string;
  stored: boolean;
  created_at: string;
}

export interface HubStatus {
  login: HubLogin;
  email: string;
  user_typeid: string;
  error: string;
}

export interface StatusRecord {
  harnesses: HarnessStatus[];
  keys: KeyStatus[];
  hub: HubStatus;
  /** Capability kind of the user's default harness, or `''`. */
  default_harness: string;
}

/** One harness's status by capability kind (`harness.claude.cli`). */
export function harnessStatus(record: StatusRecord | null | undefined, kind: string): HarnessStatus | undefined {
  return record?.harnesses.find((h) => h.kind === kind);
}
