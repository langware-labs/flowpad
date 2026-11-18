/**
 * A help desk, from both sides.
 *
 * For its team a desk is a hub PROJECT with the help desk turned on: it owns the ticket queue, and
 * its staff are the people holding a role on it. For someone asking, a desk is a CONTACT: an entry
 * in their own list on the hub (no role, no project, no files). Everything here is the hub's to
 * answer, so each call is reflected to it; the hub-only page calls the same actions directly.
 */
import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import { normalizeEmail } from '../utils/utils';
import { isHubOnly } from '../utils/hub-runtime';
import type { HelpdeskTicket } from './conversation';

/** What anyone who may ask a desk knows about it. */
export interface HelpDeskCard {
  id: string;
  display_name: string;
  avatar_url: string | null;
  enabled: boolean;
}

/** The roles that make a person staff: Reader lists the queue, Runner picks up and answers. */
const HELP_DESK_STAFF_ROLES = ['reader', 'runner'];

function hubAction(name: string, type: string | null, id: string | null, method: 'GET' | 'POST' | 'DELETE') {
  const action = new ActionInfo(name, type, id, method);
  action.hubReflect = true;
  return action;
}

/** A hub list answer, or nothing when the hub answered something else. */
const listOf = <T>(rows: T[] | null | undefined): T[] => (Array.isArray(rows) ? rows : []);

/** Create a help desk: a hub project named as a desk, its staff invited. It starts OFF -- nobody can ask
 *  until its team turns it on. Answers the desk's id. */
export async function createHelpDesk(name: string, staff: string[] = []): Promise<string> {
  const create = hubAction('', 'project', null, 'POST');
  create.bodyParameters = { name };
  const project = await dataManager.callAction<unknown, { id: string }>(create);
  const deskId = project.id;
  await setHelpDeskEnabled(deskId, false, name);
  await Promise.all(staff.map((who) => inviteHelpDeskStaff(deskId, who)));
  return deskId;
}

/** Turn a desk on or off. Off closes the door and keeps the desk; a name given here names it. */
export async function setHelpDeskEnabled(deskId: string, enabled: boolean, displayName?: string): Promise<void> {
  const action = hubAction('enable_helpdesk', 'project', deskId, 'POST');
  action.bodyParameters = { enabled, ...(displayName ? { display_name: displayName } : {}) };
  await dataManager.callAction(action);
  if (enabled) await ensureHelpDeskSources();
}

/** Invite a person (a hub user id or an email) to answer on a desk. */
export async function inviteHelpDeskStaff(deskId: string, idOrEmail: string): Promise<void> {
  const action = hubAction('members', 'project', deskId, 'POST');
  action.bodyParameters = {
    ...(idOrEmail.includes('@')
      ? { recipient_email: normalizeEmail(idOrEmail) ?? '' }
      : { recipient_user_id: idOrEmail.replace(/^user-/, '') }),
    invitation_targets: [{ typeid: `project-${deskId}`, roles: HELP_DESK_STAFF_ROLES }],
  };
  await dataManager.callAction(action);
}

/** A desk's card: its name and picture. Refused when the desk is off. */
export async function helpDeskCard(deskId: string): Promise<HelpDeskCard> {
  return await dataManager.callAction<undefined, HelpDeskCard>(hubAction('helpdesk_info', 'project', deskId, 'GET'));
}

/** A hub project, as much of it as a desk's views read. */
export interface HelpDeskProject {
  id: string;
  name?: string | null;
  helpdesk?: { enabled?: boolean; display_name?: string | null } | null;
}

/** A project that is a help desk: on, or off but still named as one. */
const isHelpDeskProject = (project: HelpDeskProject) =>
  !!project.helpdesk?.enabled || !!project.helpdesk?.display_name;

/** The desk's own project row on the hub, for its staff. Throws for anyone else. */
export async function helpDeskProject(deskId: string): Promise<HelpDeskProject> {
  return await dataManager.callAction(hubAction('', 'project', deskId, 'GET'));
}

/** The help desks this login is on the team of: the hub projects it holds that are desks. */
export async function staffedHelpDesks(): Promise<HelpDeskProject[]> {
  const rows = await dataManager.callAction<undefined, HelpDeskProject[]>(hubAction('', 'project', null, 'GET'));
  return listOf(rows).filter(isHelpDeskProject);
}

/** One ticket in a desk's queue, as the hub lists it for staff. */
export type HelpDeskTicketRow = Pick<
  HelpdeskTicket,
  'conversation_id' | 'title' | 'preview' | 'status' | 'picked_up_by' | 'created_at'
>;

/** A desk's tickets, for its staff: open and closed. */
export async function helpDeskTickets(deskId: string): Promise<HelpDeskTicketRow[]> {
  const action = hubAction('helpdesk_conversations', 'project', deskId, 'GET');
  action.queryParameters = { include_closed: 'true' };
  return listOf(await dataManager.callAction<undefined, HelpDeskTicketRow[]>(action));
}

function myDesks(userId: string, method: 'GET' | 'POST', deskId?: string) {
  const action = hubAction('helpdesks', 'user', userId.replace(/^user-/, ''), method);
  if (deskId) action.bodyParameters = { desk_project_id: deskId };
  return dataManager.callAction<unknown, HelpDeskCard[]>(action).then(listOf<HelpDeskCard>);
}

/** The help desks a person added, to ask like a contact (`userId` is their hub user id). */
export const myHelpDesks = (userId: string) => myDesks(userId, 'GET');
export const addMyHelpDesk = (userId: string, deskId: string) => myDesks(userId, 'POST', deskId);

/** Make this computer's ticket sources match the desks its login staffs, now -- and with `deskId`, bring that
 *  desk's tickets here too (they otherwise arrive on the next poll). The hub page holds no copies: nothing to do. */
export async function ensureHelpDeskSources(deskId?: string): Promise<void> {
  if (isHubOnly()) return;
  const action = new ActionInfo('ensure-sources', null, null, 'POST');
  action.bodyParameters = deskId ? { sync: deskId } : {};
  await dataManager.callAction(action);
}

/** The hub holds this row: the hub page reads the hub's own rows, a desktop holds a copy marked `remote`. */
export function isHubHeld(entity: { remote?: boolean | null } | null | undefined): boolean {
  return isHubOnly() || entity?.remote === true;
}

/** A help-desk ticket seen by someone other than the person who asked: it reaches anyone else only as the
 *  desk's staff. (`kind` is compared as text: this file takes only types from the conversation entity.) */
export function isStaffTicket(
  conversation: { kind?: string | null; remote?: boolean | null; initiated_by?: string | null } | null | undefined,
  viewerId: string | null | undefined,
): boolean {
  return conversation?.kind === 'helpdesk' && isHubHeld(conversation) && !!viewerId && conversation.initiated_by !== viewerId;
}

const TEAM_TITLE = /^\[ticket ([0-9a-fA-F-]{36})\]/;

/** The ticket a conversation is the team conversation of, else null: its title names the ticket AND its
 *  context carries it (the hub writes both; a conversation merely titled "[ticket …]" is not one). */
export function ticketOfTeamConversation(
  conversation: { title?: string | null; sharedContextEntities?: unknown[] | null } | null | undefined,
): string | null {
  const ticketId = TEAM_TITLE.exec(conversation?.title ?? '')?.[1];
  if (!ticketId) return null;
  const linked = (conversation?.sharedContextEntities ?? []).some((ref) => String(ref) === `conversation-${ticketId}`);
  return linked ? ticketId : null;
}

/**
 * A ticket's messages for desk staff who are not in it yet, where they are read straight from the hub (the hub
 * page): the watched query answers only what the role graph reaches -- nothing, for them -- so the ticket's own
 * `messages` action is asked. Null on a desktop, which reads its own copy of the ticket.
 */
export async function ticketMessagesFromHub(ticketId: string): Promise<Record<string, unknown>[] | null> {
  if (!isHubOnly()) return null;
  return listOf(
    await dataManager.callAction<undefined, Record<string, unknown>[]>(
      new ActionInfo('messages', 'conversation', ticketId, 'GET'),
    ),
  );
}

/** A ticket's private team conversation, for the desk's staff: its id, or null while nobody opened one. */
export async function teamConversationOf(ticketId: string): Promise<string | null> {
  const action = new ActionInfo('team_conversation', 'conversation', ticketId, 'GET');
  const team = await dataManager.callAction<undefined, { id?: string } | null>(action);
  return team?.id ?? null;
}

/** Open a ticket's team conversation with its first note (or join the one already there). Answers its id. */
export async function openTeamConversation(ticketId: string, text: string): Promise<string> {
  const action = new ActionInfo('open_team_conversation', 'conversation', ticketId, 'POST');
  action.bodyParameters = { title: '', text };
  const team = await dataManager.callAction<unknown, { id: string }>(action);
  return team.id;
}

/** Which side of a ticket a desk's agent works. Mirrors the backend's `HelpdeskAgentSide`. */
export enum HelpDeskAgentSide {
  /** Answers the customer (a draft on the team side while moderated). */
  CUSTOMER = 'customer',
  /** Writes notes for the team only. */
  TEAM = 'team',
}

/** One of a desk's optional agents, as the desk's page sets it up: the side it works and when it replies. */
export interface HelpDeskAgent {
  desk_project_id: string;
  side: HelpDeskAgentSide;
  instructions?: string;
  reply_not_picked_up: boolean;
  reply_tagged: boolean;
  moderated: boolean;
  agent_id?: string | null;
  agent_name?: string | null;
}

/** The desk's agents on this computer, one per side at most. Desktop only: an agent runs on a machine. */
export async function helpDeskAgents(deskId: string): Promise<HelpDeskAgent[]> {
  if (isHubOnly()) return [];
  const action = new ActionInfo('helpdesk-agents', null, null, 'POST');
  action.bodyParameters = { desk_project_id: deskId };
  return (await dataManager.callAction<unknown, HelpDeskAgent[]>(action)) ?? [];
}

/** Make one of the desk's agents: the agent, its source on the desk, and its deployment on this computer. */
export async function createHelpDeskAgent(agent: HelpDeskAgent, deskName: string): Promise<HelpDeskAgent> {
  const action = new ActionInfo('helpdesk-agent', null, null, 'POST');
  action.bodyParameters = { ...agent, desk_name: deskName };
  return (await dataManager.callAction<unknown, HelpDeskAgent>(action))!;
}
