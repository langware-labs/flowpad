import { APIEntity, registerEntity } from '../APIEntity';
import type { IEntity } from '../IEntity';

export type IssueSeverity = 'error' | 'warning';
export type IssueStatus = 'open' | 'resolved';

/** What resolves an issue: a button label and the dock URL it opens. */
export interface IssueFix {
  label: string;
  pointer: string;
}

/**
 * Something that needs fixing, kept by the hub (read-only here). One open row per (subject, kind);
 * resolved rows stay as history. Twin of `flow_sdk/builtin/issue.py`.
 */
export interface IIssue extends Omit<IEntity, 'status'> {
  subject_typeid: string;
  kind: string;
  severity: IssueSeverity;
  title: string;
  detail: string;
  fix: IssueFix | null;
  /** Typeids this issue stops (e.g. the deployments an exhausted budget halts). */
  affected: string[];
  status: IssueStatus;
  /** Epoch seconds. */
  opened_at: number;
  resolved_at: number | null;
  last_notified_at: number | null;
  count: number;
}

@registerEntity
export class Issue extends APIEntity<Issue> implements IIssue {
  static type: string = 'issue';

  subject_typeid: string;
  kind: string;
  severity: IssueSeverity;
  title: string;
  detail: string;
  fix: IssueFix | null;
  affected: string[];
  status: IssueStatus;
  opened_at: number;
  resolved_at: number | null;
  last_notified_at: number | null;
  count: number;

  constructor(entity: Partial<IIssue> | IEntity = {}) {
    super(entity);
    const issue = entity as Partial<IIssue>;
    this.subject_typeid = issue.subject_typeid ?? '';
    this.kind = issue.kind ?? '';
    this.severity = issue.severity === 'warning' ? 'warning' : 'error';
    this.title = issue.title ?? '';
    this.detail = issue.detail ?? '';
    this.fix = issue.fix?.pointer ? { label: issue.fix.label ?? '', pointer: issue.fix.pointer } : null;
    this.affected = Array.isArray(issue.affected) ? issue.affected : [];
    this.status = issue.status === 'resolved' ? 'resolved' : 'open';
    this.opened_at = issue.opened_at ?? 0;
    this.resolved_at = issue.resolved_at ?? null;
    this.last_notified_at = issue.last_notified_at ?? null;
    this.count = issue.count ?? 1;
  }

  /** Whether this issue is about `typeid` — its subject, or one of the things it stops. */
  concerns(typeid: string): boolean {
    return this.subject_typeid === typeid || this.affected.includes(typeid);
  }
}
