/**
 * The wire shape of a capability row, separate from the Capability class that hydrates it.
 * See the layering rule in `entities/compute-node/compute-node-types.ts`.
 */
import { IEntity } from '../IEntity';
import type { PromptResult } from '../models/ReturnedValue';

/** Four-state readiness (mirror of the backend CapabilityState enum).
 *  available = ready to use; not_available = probed/attempted and
 *  definitively not ready; none = user never tried; error = probe failed. */
export type CapabilityState = 'available' | 'not_available' | 'none' | 'error';

export type CapabilityActionName = 'test' | 'setup';

export interface CapabilityResult {
  ok: boolean;
  available: boolean;
  message: string;
  details?: Record<string, unknown>;
  process_id?: string | null;
  checked_at?: string;
  state?: CapabilityState;
  /** The worker's own answer when an install or a probe ran one. */
  answer?: PromptResult | null;
}

export interface CapabilityCheck {
  kind: string;
  scope_type?: string | null;
  scope_id?: string | null;
  result: CapabilityResult;
  dependencies?: Record<string, CapabilityResult>;
}

export type DeviceLoginState = 'idle' | 'starting' | 'awaiting_user' | 'authenticated' | 'error';

/** Snapshot of a device-login flow (mirror of the backend session's to_json). */
export interface DeviceLoginStatus {
  state: DeviceLoginState;
  url: string | null;
  code: string | null;
  message: string;
  accepts_code_paste: boolean;
}

/** Result of the backend auth probe (WorkerAuthResult.to_json). */
export interface WorkerAuthStatus {
  status: 'not_installed' | 'logged_in' | 'logged_out' | 'unknown';
  verified: boolean;
  message: string;
  details: Record<string, unknown>;
  /** How the harness authenticates: device login vs a stored LLM-provider key. */
  auth_mode?: 'device' | 'api';
  /** Providers this harness can authenticate against (from its ApiAuthSpec);
   *  also mirrored under details.supported_providers. */
  supported_providers?: string[];
}

export interface ICapability extends IEntity {
  name: string;
  kind: string;
  /** Entity scope this row is bound to; null on the global row. Mirrors the
   *  backend `Capability.scope_type` / `.scope_id` (flow_sdk/builtin/capability.py). */
  scope_type?: string | null;
  scope_id?: string | null;
  description?: string;
  icon?: string | null;
  homepage_url?: string | null;
  dependent_capability_kinds?: string[];
  /** CapabilityReference pointer: kind this row delegates to (e.g. Default harness → harness.claude.cli). */
  reference_kind?: string | null;
  /** Prompt the install agentic process runs with (null → backend default). */
  install_prompt?: string | null;
  /** One-liner that installs this capability on THIS machine, resolved by the
   *  backend from its per-platform table (`CapabilitySpec.install_commands`).
   *  Null → no unattended installer, so no auto-install affordance. */
  install_command?: string | null;
  /** Discovered typed value (null ⇔ capability absent). For harness CLIs an
   *  FSRef dict of the bin folder — the same value workers spawn with. */
  value?: Record<string, unknown> | null;
  /** Static RecordType of `value` (e.g. "folder"); from the backend spec. */
  value_type?: string | null;
  /** Persisted four-state readiness (see CapabilityState). */
  state?: CapabilityState;
  last_check?: CapabilityResult | null;
  last_setup?: CapabilityResult | null;
  last_test?: CapabilityResult | null;
  /** Device-login runtime state — broadcast-only, never persisted. */
  login_state?: DeviceLoginState | null;
  login_url?: string | null;
  login_code?: string | null;
  login_accepts_code?: boolean | null;
  login_message?: string | null;
  /** The harness's own refusal, recorded by `report-signed-out` and retracted by
   *  the backend the moment newer evidence lands (a completed device login, a
   *  verified probe, an explicit Test). Broadcast-only, like the rest of the
   *  login_* block — and the single source of truth for "this box says it is
   *  signed out", which is why no client keeps a copy of its own. */
  login_denied?: boolean;
  /** How this harness authenticates its worker: "device" (default) or "api"
   *  (a stored LLM-provider key). Persisted + user-switchable. */
  auth_mode?: 'device' | 'api' | null;
  /** Chosen LMApiProvider value when auth_mode === 'api' (null → driver default). */
  api_provider?: string | null;
  /** User overrides for the tier→model mapping, layered over the driver defaults:
   *  {provider: {name: slug}} where name is a tier (sm/md/lg) or a custom option. */
  model_map?: Record<string, Record<string, string>>;
}
