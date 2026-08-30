import { Project, User, Visitor, Workspace } from '../entities';
import { JSONSchemaProperty, TypeInfo } from '../FlowSync/schema';
import { ComputeNode } from '../entities/compute_node';
import { ComputeProviderType } from '../entities/compute-node/compute-node-types';
import { AgentHook } from '../entities/agent-hook';
import { WebDomain } from '../entities/web-domain';
import { CapabilitiesSummary } from '../capabilities/CapabilityManager';
import { RuntimeInfo } from '../utils/runtime';

/**
 * Environment information returned in bootstrap
 */
export interface EnvInfo {
  /**
   * Legacy: a hardcoded `"desktop"` literal on every flow_sdk backend, so it is
   * `"desktop"` inside a cloud sandbox too. It means "a flow_sdk server
   * answered", nothing more. Read `BootstrapInfo.runtime.kind` instead.
   */
  env_name: string;
  /** FLOWPAD_CLOUD_API_URL if set */
  cloud_api_url?: string;
  /** App version (e.g., "0.1.28") */
  version?: string;
  /** Current instance name (e.g., "prod", "dev", "test"); dev-mode only */
  instance_name?: string;
}

/**
 * Application paths - VFS-relative paths ready to use with fsManager.
 * All paths are relative to the storage mount (OS root), without leading slash.
 */
export interface AppPaths {
  /** Filesystem root ("/" on Unix, "C:\\" on Windows) */
  root: string;
  /** User home directory ("Users/alice") */
  home: string;
  /** FlowPad workspace folder ("Users/alice/Flowpad workspace") */
  workspace: string;
  /** Skills folder ("Users/alice/Flowpad workspace/.claude/skills") */
  skills: string;
  /** User skills folder ("Users/alice/.claude/skills") */
  user_skills: string;
  /** System skills folder ("Users/alice/Flowpad workspace/.flow/system_assets/skills") */
  system_skills: string;
  /** System agents folder ("Users/alice/Flowpad workspace/.flow/system_assets/agents") */
  system_agents: string;
  /** Logs folder ("Users/alice/Flowpad workspace/.flow/logs") */
  logs: string;
  /** Per-instance UI preferences file ("Users/alice/.flow/instances/<name>/preferences.json") */
  preferences: string;
}

/**
 * Desktop/LLM information returned in bootstrap
 */
export interface LmInfo {
  /** Available LLM providers (Anthropic, OpenAI, etc.) */
  llm_providers: string[];
  /** Installed agent applications (Claude Code, Cursor, etc.) */
  installed_agents: string[];
  /** Whether cloud login is available (valid cloud token exists) */
  cloud_login_available: boolean;
  /** Cloud (FLOWPAD_HUB_URL) base URL — shown in login button tooltip */
  cloud_url?: string | null;
  /** Hub browser application origin; unlike cloud_url this has no /api/v1 suffix. */
  cloud_app_url?: string | null;
  /** Application paths - all absolute, ready to use */
  paths?: AppPaths;
  /** @deprecated Use paths.home instead - Filesystem root (/ on Unix, C:\ on Windows) */
  home?: string;
  /** @deprecated Use paths.workspace instead - User workspace folder (~/Flowpad workspace) */
  workspace?: string;
  /** @deprecated Use paths.skills instead - Skills folder path (~/Flowpad workspace/.claude/skills) */
  skills?: string;
}

export interface ScanInfo {
  total_indexed: number;
  last_indexed_at: string | null;
  never_indexed: boolean;
  stale: boolean;
}

export interface HarnessBootstrapItem {
  kind: string;
  name: string;
  installed: boolean;
  homepage_url?: string | null;
  is_default: boolean;
}

export interface HarnessBootstrapState {
  show_harness_select: boolean;
  harnesses: HarnessBootstrapItem[];
}

/**
 * One-time, UI-facing notice produced during bootstrap (e.g. the per-instance
 * secrets file was reset after its keychain encryption key was lost). Surfaced
 * as a startup toast. Absent on a normal bootstrap.
 */
export interface BootstrapNotice {
  /** Stable id so the UI can de-dupe / dismiss (e.g. "secrets-reset"). */
  id: string;
  /** Severity, drives toast styling. */
  level: 'info' | 'warning' | 'error';
  /** Short headline. */
  title: string;
  /** Friendly explanation of what happened and what to do next. */
  message: string;
}

export interface BootstrapInfo {
  // Complete type registry: TypeInfo (icon/browseable_by/creatable/fields) +
  // nested JSON schema, one entry per registered type. Loaded into the
  // frontend SchemaRegistry (dataManager.typeInfos) at startup.
  types?: TypeInfo[];
  /** Compatibility payload emitted by older Hub backends before TypeInfo. */
  schemas?: JSONSchemaProperty[];
  user?: User;
  domain?: WebDomain;
  visitor?: Visitor;
  default_project?: Project;
  default_workspace?: Workspace;
  default_compute_node?: ComputeNode;
  /**
   * The provider a hub mints new compute nodes on, from its own
   * `FLOWPAD_DEFAULT_COMPUTE_PROVIDER`.
   *
   * HUB-ONLY: the OSS backend does not emit it, so it is absent whenever the
   * SPA is served by a local/desktop backend rather than the hub. Consumers
   * must carry their own fallback and validate it — the hub's default is
   * `local_machine`, which can host compute nodes but never a sandbox.
   */
  default_compute_provider?: ComputeProviderType;
  /** True iff the backend has E2B configured and the @sandbox compute node is available. */
  sandbox_available?: boolean;
  /** Raw ComputeNode payload for the @sandbox node (E2B-backed). Hydrate via dataContext.sandboxComputeNode. */
  sandbox_compute_node?: ComputeNode;
  /** Hub only: whether the hub can provision cloud desktops (e2b workspaces).
   *  False when the hub has no e2b API key; "New Desktop" is disabled on it. */
  /** Whether this hub can provision cloud sandboxes (needs an e2b key).
   *  Renamed from `desktops_enabled` with NO alias — hub and app ship together.
   *  Absent means an older hub, which is treated as enabled by the caller. */
  sandboxes_enabled?: boolean;
  env?: EnvInfo;
  /**
   * What this app is running as — the single signal every surface reads.
   * Resolved server-side per request (it depends on the `electron` flag this
   * client sent), so it is not part of the backend's cached bootstrap payload.
   */
  runtime?: RuntimeInfo;
  desktop_info?: LmInfo;
  harness_state?: HarnessBootstrapState;
  /** All capabilities + how to access each, grouped by intent (see CapabilityManager). */
  capabilities_summary?: CapabilitiesSummary;
  sniffer_hook?: AgentHook;
  /** Harness settings file actually carries sniffer hooks — true even when
   *  another instance on this machine installed them (no local entity). */
  sniffer_installed?: boolean;
  scan_info?: ScanInfo;
  records_root?: string;
  /** Locales the app ships translations for (backend is the source of truth).
   *  The UI derives its picker from this — it does not hardcode a list. */
  supported_locales?: SupportedLocale[];
  /** Target languages for *document* translation (backend is the source of
   *  truth: flow_sdk/i18n/translation_targets.py). DISTINCT from
   *  `supported_locales` (the UI-catalog set) — this is the broad set the
   *  translator worker can render a doc into. Feeds the Translations side-panel
   *  picker. `flag` is absent (document targets are language-only). */
  translation_targets?: TranslationTarget[];
  /** SPA-surfaces ("pages") this server serves, as `PageId` strings (dock URL
   *  grammar / `DockPointer.page`). The local desktop server serves only
   *  `"desk"`; a hub backend reports its own set. Navigation to a page not in
   *  this list redirects to the first supported page's home. Absent ⇒ desk-only. */
  supported_pages?: string[];
  /** Data-privacy mode this instance is in, from the backend's
   *  `instance_settings/privacy_mode.py`. Seeds `privacyManager`; live changes
   *  arrive afterwards on `privacy_mode_msg`. */
  privacy_mode?: 'local' | 'connected';
  /** One-time startup notice (e.g. secrets were reset). Absent normally. */
  notice?: BootstrapNotice;
}

/** A document-translation target language. Mirrors the backend descriptor in
 *  flow_sdk/i18n/translation_targets.py. Same shape as `SupportedLocale` minus
 *  `flag`, so the `LanguageSelector` picker renders it unchanged. */
export interface TranslationTarget {
  /** BCP-47-ish code — the `?lang=` dock-prop value and `<lang>.md` filename. */
  code: string;
  /** English name (for secondary label / search). */
  englishName: string;
  /** Endonym — the language's own name. */
  nativeName: string;
  /** Text direction of the translated document; drives the editor `dir`. */
  dir: 'ltr' | 'rtl';
}

/** A locale the app ships translations for. Mirrors the backend descriptor in
 *  flow_sdk/i18n/supported_locales.py; the UI aliases this as `LocaleInfo`. */
export interface SupportedLocale {
  /** BCP-47-ish code used as the catalog key and `<html lang>`. */
  code: string;
  /** English name (for secondary label / search). */
  englishName: string;
  /** Endonym — the language's own name. */
  nativeName: string;
  /** Text direction; drives `<html dir>`. */
  dir: 'ltr' | 'rtl';
  /** ISO 3166-1 alpha-2 region for the flag-icons SVG (language≠country; this
   *  is a chosen representative region, not a linguistic claim). */
  flag: string;
}
