/**
 * The diagnosis contract — a mirror of `flow_sdk/schema/data_spec/diagnose_spec.py` (`diagnosis`,
 * `flow.context`), kept in step by `tests/unit/test_diagnose/test_ts_parity.py`.
 *
 * A diagnose (an asset: `diagnose.json` + `diagnose.py`) is called with a `FlowContextSpec` and
 * answers a `DiagnosisSpec`. One that fails or hangs still answers the baseline, `status: 'partial'`.
 */

export type DiagnosisStatus = 'ok' | 'informational' | 'needs_action' | 'fixed' | 'unrecognized' | 'partial';
export type DiagnosePurpose = 'report' | 'repair';
/** Whose problem it is — a report is offered only for `flowpad`, `dependency` and `unknown`. */
export type DiagnosisCause = 'flowpad' | 'dependency' | 'project' | 'machine' | 'unknown';

export interface SessionTurn {
  role: string;
  text: string;
}

export interface SessionState {
  process: string;
  title: string;
  status: string;
  worker: string;
  turns: SessionTurn[];
}

export interface FlowContextSpec {
  purpose: DiagnosePurpose;
  project_id: string | null;
  project_path: string | null;
  process: string | null;
  user_report: string;
  origin: string;
  instance: string;
  view: string;
  address: string;
  entity: string;
  session: SessionState | null;
  hub_login: string;
  other_sessions: SessionState[];
}

export interface DiagnosisFinding {
  id: string;
  severity: string;
  title: string;
  detail: string;
  evidence: string;
}

export interface DiagnosisEnvironment {
  reported_by: string;
  occurred_at: string;
  os: string;
  app_version: string;
  python: string;
  instance: string;
  backend_port: number | null;
  hub_url: string;
}

export interface LogTail {
  file: string;
  lines: string[];
}

export interface DiagnosisSpec {
  status: DiagnosisStatus;
  cause: DiagnosisCause;
  /** The dependency's name when `cause` is `dependency`. */
  cause_asset: string;
  title: string;
  summary: string;
  symptoms: string;
  rca: string;
  fix: string;
  findings: DiagnosisFinding[];
  environment: DiagnosisEnvironment;
  logs: LogTail[];
  context: FlowContextSpec | null;
  /** Which diagnose answered (`flowpad`, a project's own); empty when none could run. */
  diagnose: string;
  /** What went wrong while diagnosing. */
  errors: string[];
  started_at: string;
  elapsed_ms: number;
}

/** Something is wrong and someone else owns the fix — mirrors `DiagnosisSpec.reportable`. */
export function isReportable(d: Pick<DiagnosisSpec, 'status' | 'cause'>): boolean {
  if (d.status === 'ok' || d.status === 'informational') return false;
  return d.cause === 'flowpad' || d.cause === 'dependency' || d.cause === 'unknown';
}
