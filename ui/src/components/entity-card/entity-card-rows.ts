import { msg } from '@lingui/core/macro';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { channelLabel } from '@src/components/conversation/channel-attribution';
import { participantLabel } from '@src/components/conversation/participant-display';
import { PRIORITY_CONFIG, statusLabel } from '@src/components/task-bar/constants';
import { formatTimeAgoShort } from '@src/utils/format-time-ago';
import { humanizeType } from '@src/utils/humanize';

/** One label/value line of an entity card. `copy` renders the value as a copy button. */
export interface EntityCardRow {
  label: string;
  value: string;
  copy?: boolean;
}

/** An entity read loosely: a card shows whichever of these facts the entity happens to carry. */
export type EntityFields = Record<string, unknown>;
type Fields = EntityFields;
/** A reader answers text, a translatable word, or several values (one row each). */
type RowSpec = [MessageDescriptor, (e: Fields) => string | MessageDescriptor | string[], { copy?: boolean }?];

export const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const word = (v: unknown): string => (text(v) ? humanizeType(text(v)) : '');
const ago = (v: unknown): string => (v ? formatTimeAgoShort(v as string) : '');
const count = (v: unknown): string => (typeof v === 'number' ? String(v) : '');
const onOff = (v: unknown): MessageDescriptor | '' => (typeof v === 'boolean' ? (v ? msg`On` : msg`Off`) : '');

/** The people on a roster, by name (else email). */
function rosterNames(roster: unknown): string[] {
  const people = Array.isArray(roster) ? (roster as Fields[]) : [];
  return people.filter((m) => text(m.name) || text(m.email)).map((m) => participantLabel(m));
}

/** Who a conversation is with: its channel addresses, else the people on its roster. */
function conversationWith(e: Fields): string[] {
  const address = Array.isArray(e.address) ? e.address.map(text).filter(Boolean) : [];
  return address.length ? address : rosterNames(e.members);
}

/** A roster on one line — the first three names, then how many more. */
function people(roster: unknown): string {
  const names = rosterNames(roster);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
}

const STATUS: RowSpec = [msg`Status`, (e) => word(e.status)];
const UPDATED: RowSpec = [msg`Updated`, (e) => ago(e.updated_date)];
/** A harness transcript, whichever harness wrote it. */
const SESSION: RowSpec[] = [[msg`Messages`, (e) => count(e.message_count)], UPDATED];

/**
 * What an entity card says about each type, beyond the name / kind / description /
 * path every card carries. A type with no entry shows its status and last update.
 * Empty values are dropped, so a row only appears when the entity has the fact.
 */
const ROWS: Record<string, RowSpec[]> = {
  conversation: [
    [msg`Channel`, (e) => channelLabel(text(e.channel)) || msg`Flowpad`],
    [msg`Project`, (e) => text(e.remote_project_name)],
    [msg`Messages`, (e) => count(e.message_count)],
    [msg`Unread`, (e) => (typeof e.unread_count === 'number' && e.unread_count > 0 ? String(e.unread_count) : '')],
    [msg`Started`, (e) => ago(e.started_at ?? e.created_date)],
    STATUS,
    [msg`With`, conversationWith, { copy: true }],
  ],
  shell: [STATUS, [msg`Machine`, (e) => text(e.compute_node_uname)], [msg`Started`, (e) => ago(e.created_at ?? e.created_date)]],
  micro_app: [[msg`Kind`, (e) => word(e.kind)], [msg`Build`, (e) => text(e.build)], UPDATED],
  artifact: [
    [msg`Kind`, (e) => word(e.kind)],
    [msg`Health`, (e) => word(e.health)],
    [msg`Port`, (e) => count(e.port)],
    [msg`Start`, (e) => text(e.start_cmd)],
  ],
  service_endpoint: [
    [msg`Kind`, (e) => word(e.subkind)],
    STATUS,
    [msg`Health`, (e) => word(e.health)],
    [msg`Protocol`, (e) => text(e.protocol)],
  ],
  project: [
    [msg`Members`, (e) => people(e.members)],
    [msg`Published`, (e) => ago(e.hub_published_at)],
    [msg`Mode`, (e) => word(e.last_mode)],
    UPDATED,
  ],
  task: [
    // The task screens' own words: a `to_do` task reads "New" everywhere.
    [msg`Status`, (e) => (text(e.status) ? statusLabel(text(e.status)) : '')],
    [msg`Priority`, (e) => PRIORITY_CONFIG[text(e.priority)]?.label ?? word(e.priority)],
    [msg`Assignee`, (e) => text(e.assignee)],
    [msg`Due`, (e) => ago(e.due_at)],
  ],
  graph_workflow: [[msg`Enabled`, (e) => onOff(e.enabled)], UPDATED],
  remote_worker_session: [
    [msg`Host`, (e) => text(e.host_name)],
    [msg`Guest`, (e) => text(e.guest_name)],
    STATUS,
    [msg`Started`, (e) => ago(e.started_at)],
    [msg`Active`, (e) => ago(e.last_activity_at)],
  ],
  data_source: [
    [msg`Driver`, (e) => word(e.provider ?? e.data_driver_name)],
    STATUS,
    [msg`Health`, (e) => word(e.health)],
    [msg`Synced`, (e) => ago(e.last_synced_at)],
    [msg`Error`, (e) => text(e.error_detail)],
  ],
  dataset: [[msg`Rows`, (e) => count(e.num_examples)], [msg`Annotated`, (e) => count(e.num_annotated)], UPDATED],
  llm_endpoint: [
    [msg`Provider`, (e) => text(e.provider)],
    [msg`Enabled`, (e) => onOff(e.enabled)],
    [msg`Models`, (e) => (e.models && typeof e.models === 'object' ? String(Object.keys(e.models).length || '') : '')],
    [msg`URL`, (e) => text(e.base_url), { copy: true }],
  ],
  diagnosis_request: [[msg`Runs`, (e) => count(e.run_count)], [msg`Last run`, (e) => ago(e.last_run_at)]],
  flowpad_diagnosis: [
    [msg`Reported by`, (e) => text(e.reported_by)],
    [msg`Occurred`, (e) => ago(e.occurred_at)],
    [msg`OS`, (e) => text(e.os)],
    [msg`Version`, (e) => text(e.app_version)],
  ],
  spec: [[msg`Kind`, (e) => word(e.spec_type)], UPDATED],
  claude_session: SESSION,
  codex_session: SESSION,
  copilot_session: SESSION,
};

const FALLBACK: RowSpec[] = [STATUS, UPDATED];

export function entityCardRows(type: string, entity: EntityFields): EntityCardRow[] {
  return (ROWS[type] ?? FALLBACK).flatMap(([label, read, opts]) => {
    const value = read(entity);
    const values = Array.isArray(value) ? value : [typeof value === 'string' ? value : i18n._(value)];
    return values.filter(Boolean).map((v) => ({ label: i18n._(label), value: v, copy: opts?.copy }));
  });
}

/** Where the entity lives on disk, when it does. */
export function entityCardPath(e: EntityFields): string {
  return text(e.asset_ref) || text(e.workdir) || text(e.cwd) || text(e.fs_storage_mount_path) || text(e.path);
}
