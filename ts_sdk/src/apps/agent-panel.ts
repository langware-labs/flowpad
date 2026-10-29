/**
 * `<flowpad-agent>` — a served app's agent, inside the app.
 *
 * The tag draws the agent's icon where it is placed. Clicking it slides the agent's chat in
 * from the left; the rest of the page narrows to make room (the page's `body` gets the panel's
 * width as a left margin). Closing it collapses the chat back into the icon, so the icon is the
 * agent's toggle.
 *
 * Everything comes from the SDK — no host, no message to the Flowpad window:
 *  - which agent: the `agent` attribute (name or TypeId), else the asset the app is nested in
 *    (`resolveAppHost().subject`) when that is an agent;
 *  - which project: the `project` attribute, else the app's own project;
 *  - which chat: the last one (`Agent.openChat`), a new one from the panel's New chat button
 *    (`Agent.newChat`);
 *  - the messages: the process's `flowDataStream`, live; sending is `enqueue`, Stop is
 *    `interruptTurn`.
 *
 * Nothing starts until the panel is first opened. With no served-app URL or no agent the tag
 * hides itself and the page works as before.
 */
import { dataManager } from '../APIEntity';
import { QueryFilter, QueryRequest } from '../FlowSync/query';
import { Agent } from '../entities/agent';
import type { FlowData } from '../flow_processing/flow-data';
import { FlowElementTypes } from '../flow_processing/flow-element-types';
import { asyncSdkInit, initSdk } from '../main';
import { TypeId } from '../models/TypeId';
import type { AgenticProcess } from '../process/agentic-process';
import { getDisplayStatus, isBusy } from '../process/agentic-types';
import { PROCESS_STATUS_LABEL, WORKER_STATUS_LABEL } from '../process/status-labels';
import { appTypeId, resolveAppHost } from './host';

export const AGENT_PANEL_TAG = 'flowpad-agent';
/** The panel's width; the page's left margin while it is open. */
export const AGENT_PANEL_WIDTH = 380;
const OPEN_ATTR = 'data-fp-agent';
const PAGE_STYLE_ID = 'flowpad-agent-css';

/** The page-level half: the room the panel takes, and the motion both sides share. */
const PAGE_CSS = `
:root { --fp-agent-w: 0px; }
:root[${OPEN_ATTR}="open"] { --fp-agent-w: ${AGENT_PANEL_WIDTH}px; }
:root body { margin-left: var(--fp-agent-w); transition: margin-left .25s ease; }
@media (prefers-reduced-motion: reduce) { :root body { transition: none; } }
`;

const BUTTON_CSS = `
:host { display: inline-flex; vertical-align: middle; }
:host([hidden]) { display: none; }
button { all: unset; cursor: pointer; position: relative; display: inline-flex; align-items: center;
  justify-content: center; width: 30px; height: 30px; border-radius: 999px;
  box-shadow: 0 0 0 1px hsl(var(--border, 0 0% 89.8%)); transition: box-shadow .15s, transform .15s; }
button:hover { transform: scale(1.06); }
button:focus-visible { box-shadow: 0 0 0 2px hsl(var(--ring, 0 0% 3.9%)); }
button[aria-expanded="true"] { box-shadow: 0 0 0 2px hsl(var(--primary, 0 0% 9%)); }
.dot { position: absolute; right: -1px; bottom: -1px; width: 9px; height: 9px; border-radius: 999px;
  background: hsl(var(--muted-foreground, 0 0% 45%)); box-shadow: 0 0 0 2px hsl(var(--background, 0 0% 100%)); }
.dot.live { background: #22c55e; animation: pulse 1.2s ease-in-out infinite; }
.dot.bad { background: hsl(var(--destructive, 0 84% 60%)); }
.dot.none { display: none; }
@keyframes pulse { 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) { .dot.live { animation: none; } button { transition: none; } }
`;

const AVATAR_CSS = `
.av { width: 100%; height: 100%; border-radius: 999px; overflow: hidden; display: inline-flex;
  align-items: center; justify-content: center; font: 600 13px var(--font-sans, system-ui, sans-serif);
  color: #fff; user-select: none; }
.av img { width: 100%; height: 100%; object-fit: cover; }
`;

const PANEL_CSS = `
:host { all: initial; position: fixed; inset: 0 auto 0 0; z-index: 2147483000; width: ${AGENT_PANEL_WIDTH}px;
  transform: translateX(-100%); transition: transform .25s ease; visibility: hidden;
  font: 14px/1.45 var(--font-sans, system-ui, sans-serif); color: hsl(var(--foreground, 0 0% 3.9%)); }
:host([open]) { transform: none; visibility: visible; }
@media (prefers-reduced-motion: reduce) { :host { transition: none; } }
.panel { box-sizing: border-box; height: 100%; display: flex; flex-direction: column;
  background: hsl(var(--background, 0 0% 100%)); border-right: 1px solid hsl(var(--border, 0 0% 89.8%));
  box-shadow: 6px 0 24px -18px rgba(0,0,0,.35); }
header { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border-bottom: 1px solid hsl(var(--border, 0 0% 89.8%)); }
header .face { width: 26px; height: 26px; flex: none; }
header .name { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px;
  border-radius: var(--radius-md, 6px); font-size: 12.5px; color: hsl(var(--muted-foreground, 0 0% 45%)); }
.btn:hover { background: hsl(var(--muted, 0 0% 96%)); color: hsl(var(--foreground, 0 0% 3.9%)); }
.btn:focus-visible { outline: 2px solid hsl(var(--ring, 0 0% 3.9%)); }
.btn[disabled] { opacity: .5; pointer-events: none; }
.log { flex: 1; overflow-y: auto; padding: 14px 14px 6px; display: flex; flex-direction: column; gap: 10px; }
.empty { margin: auto; text-align: center; color: hsl(var(--muted-foreground, 0 0% 45%)); font-size: 13px; padding: 0 12px; }
.me { align-self: flex-end; max-width: 85%; padding: 7px 11px; border-radius: 14px 14px 4px 14px;
  background: hsl(var(--muted, 0 0% 96%)); white-space: pre-wrap; overflow-wrap: anywhere; }
.agent { white-space: pre-wrap; overflow-wrap: anywhere; }
.tool { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  padding: 3px 8px; border-radius: var(--radius-md, 6px); border: 1px solid hsl(var(--border, 0 0% 89.8%) / .7);
  background: hsl(var(--muted, 0 0% 96%) / .45); color: hsl(var(--muted-foreground, 0 0% 45%)); font-size: 12.5px; }
.tool b { font-weight: 500; white-space: nowrap; }
.tool span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px var(--font-mono, ui-monospace, monospace); }
.err { color: hsl(var(--destructive-text, 0 72% 45%)); font-size: 13px; }
.status { padding: 0 14px 6px; font-size: 12px; color: hsl(var(--muted-foreground, 0 0% 45%)); min-height: 18px;
  display: flex; align-items: center; gap: 8px; }
.status .retry { margin-left: auto; }
form { display: flex; gap: 8px; align-items: flex-end; padding: 10px 12px 12px; border-top: 1px solid hsl(var(--border, 0 0% 89.8%)); }
textarea { all: unset; box-sizing: border-box; flex: 1; min-height: 38px; max-height: 140px; overflow-y: auto; padding: 8px 10px;
  border: 1px solid hsl(var(--input, 0 0% 89.8%)); border-radius: var(--radius-md, 6px); white-space: pre-wrap; }
textarea:focus { border-color: hsl(var(--ring, 0 0% 3.9%)); }
.send { all: unset; cursor: pointer; padding: 8px 12px; border-radius: var(--radius-md, 6px); font-weight: 500;
  background: hsl(var(--primary, 0 0% 9%)); color: hsl(var(--primary-foreground, 0 0% 98%)); }
.send[disabled] { opacity: .5; pointer-events: none; }
${AVATAR_CSS}
`;

const MESSAGE_TYPES = new Set<string>([FlowElementTypes.USER_MESSAGE, FlowElementTypes.CHAT, FlowElementTypes.TEXT]);
const LIVE_STATUSES = new Set(['working', 'thinking', 'tool_call', 'tool_running', 'initializing', 'starting', 'new']);

/** One row of the chat, as the panel draws it. Exported for tests. */
export type ChatRow =
  | { kind: 'me' | 'agent'; text: string }
  | { kind: 'tool'; label: string; detail: string; count: number };

/**
 * The stream as chat rows, vibe-mode style: the person's and the agent's text as messages, and
 * every run of tool calls between two messages as ONE muted row (its latest call, and how many).
 */
export function chatRows(items: readonly FlowData[]): ChatRow[] {
  const rows: ChatRow[] = [];
  for (const item of items) {
    const type = item.elementType;
    if (MESSAGE_TYPES.has(type)) {
      if (item.attributes['is-meta'] === 'true') continue; // a framework injection, not a turn
      const text = String(item.content ?? '').trim();
      if (!text || text === '*no content*') continue;
      const kind = type === FlowElementTypes.USER_MESSAGE ? 'me' : 'agent';
      const last = rows[rows.length - 1];
      // An optimistic echo and the transcript's own copy of the same turn are one message.
      if (kind === 'me' && last?.kind === 'me' && last.text === text) continue;
      // A streamed reply arrives as consecutive frames: one message.
      if (kind === 'agent' && last?.kind === 'agent' && type !== FlowElementTypes.CHAT) last.text += `\n${text}`;
      else rows.push({ kind, text });
    } else if (type === FlowElementTypes.TOOL_CALL) {
      const entry = (item.processEntry?.transcript_entry ?? null) as Record<string, unknown> | null;
      const label = item.attributes['tool-name'] || String(entry?.tool ?? '') || 'Tool';
      const detail = String(entry?.path ?? entry?.command ?? entry?.target ?? '');
      const last = rows[rows.length - 1];
      if (last?.kind === 'tool') Object.assign(last, { label, detail, count: last.count + 1 });
      else rows.push({ kind: 'tool', label, detail, count: 1 });
    }
  }
  return rows;
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function avatarHtml(agent: Agent): string {
  const url = agent.avatarImageUrl;
  const color = (agent as { color?: string | null }).color || '#64748b';
  if (url) return `<span class="av"><img alt="" src="${esc(url)}"></span>`;
  const avatar = (agent.avatar || '').trim();
  // An emoji avatar draws as itself; a name (an icon id) or nothing draws the agent's initial.
  const glyph = avatar && !/^[\w-]+$/.test(avatar) ? avatar : (agent.displayName || agent.name || '?').charAt(0).toUpperCase();
  return `<span class="av" style="background:${esc(color)}">${esc(glyph)}</span>`;
}

function statusText(process: AgenticProcess): string {
  const s = String(getDisplayStatus(process) ?? '');
  return (WORKER_STATUS_LABEL as Record<string, string>)[s] || (PROCESS_STATUS_LABEL as Record<string, string>)[s] || s;
}

function working(process: AgenticProcess | null): boolean {
  return !!process && (isBusy(process) || LIVE_STATUSES.has(String(getDisplayStatus(process))));
}

function remembered(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'open';
  } catch {
    return false;
  }
}

function remember(key: string, open: boolean): void {
  try {
    localStorage.setItem(key, open ? 'open' : 'closed');
  } catch {
    /* private window: the panel just starts closed next time */
  }
}

function ensurePageStyles(): void {
  if (document.getElementById(PAGE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PAGE_STYLE_ID;
  style.textContent = PAGE_CSS;
  document.head.appendChild(style);
}

/** The agent named by `ref` (TypeId or name), or null. */
async function agentNamed(ref: string): Promise<Agent | null> {
  if (/^agent-[0-9a-f-]{36}$/i.test(ref)) {
    return (await dataManager.getByTypeId<Agent>(new TypeId(ref)).catch(() => null)) ?? null;
  }
  const [row] = await dataManager.query<Agent>(
    new QueryRequest({ type: Agent.type, scope: [], name: `agent:${ref}`, query: new QueryFilter({ match: { name: ref } }) }),
  );
  return row ?? null;
}

/** The chat itself: a fixed panel at the page's left edge, in its own shadow root. */
class AgentPanel {
  readonly host = document.createElement('div');
  private readonly root = this.host.attachShadow({ mode: 'open' });
  private process: AgenticProcess | null = null;
  private stop: Array<() => void> = [];
  private error: { text: string; retry: () => void } | null = null;
  private loading = false;

  constructor(
    private readonly agent: Agent,
    private readonly projectId: string,
    private readonly onClose: () => void,
    private readonly onStatus: (process: AgenticProcess | null, failed: boolean) => void,
  ) {
    this.host.setAttribute('data-testid', 'flowpad-agent-panel');
    this.root.innerHTML = `<style>${PANEL_CSS}</style>
      <div class="panel" role="complementary" aria-label="${esc(agent.displayName || agent.name || 'Agent')}">
        <header>
          <span class="face">${avatarHtml(agent)}</span>
          <span class="name">${esc(agent.displayName || agent.name || 'Agent')}</span>
          <button type="button" class="btn" data-act="new" title="New chat">＋ New chat</button>
          <button type="button" class="btn" data-act="close" aria-label="Close" title="Close">⟨</button>
        </header>
        <div class="log" aria-live="polite"></div>
        <div class="status"></div>
        <form>
          <textarea rows="1" placeholder="Ask ${esc(agent.displayName || 'the agent')}…" aria-label="Message"></textarea>
          <button type="submit" class="send">Send</button>
        </form>
      </div>`;
    this.root.addEventListener('click', (e) => {
      const act = (e.target as Element).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'close') this.onClose();
      else if (act === 'new') void this.load(() => this.agent.newChat(this.projectId));
      else if (act === 'stop') void this.process?.interruptTurn().catch((err) => this.fail(err, () => {}));
      else if (act === 'retry') this.error?.retry();
    });
    const input = this.root.querySelector('textarea')!;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.root.querySelector('form')!.requestSubmit();
      }
    });
    this.root.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.send(input);
    });
  }

  get isOpen(): boolean {
    return this.host.hasAttribute('open');
  }

  open(): void {
    this.host.setAttribute('open', '');
    if (!this.process && !this.loading) void this.load(() => this.agent.openChat(this.projectId));
    setTimeout(() => this.root.querySelector('textarea')?.focus(), 260);
  }

  close(): void {
    this.host.removeAttribute('open');
  }

  /** Show the chat `pick` answers: its history, then everything it streams. */
  async load(pick: () => Promise<AgenticProcess>): Promise<void> {
    this.loading = true;
    this.error = null;
    this.detach();
    this.process = null;
    this.render();
    try {
      void asyncSdkInit(); // the live connection that carries the stream
      const process = await pick();
      this.process = process;
      const stream = process.flowDataStream;
      const redraw = () => this.render();
      stream.on('data', redraw);
      stream.on('clear', redraw);
      this.stop.push(() => {
        stream.off('data', redraw);
        stream.off('clear', redraw);
      });
      this.stop.push(process.subscribe(() => this.render()));
      const unwatch = await process.watch().catch(() => null);
      if (unwatch) this.stop.push(() => void unwatch());
      await process.loadHistory().catch((err) => console.warn('[flowpad-agent] history not loaded', err));
    } catch (err) {
      this.fail(err, () => void this.load(pick));
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async send(input: HTMLTextAreaElement): Promise<void> {
    const text = input.value.trim();
    if (!text || !this.process) return;
    input.value = '';
    try {
      await this.process.enqueue(text, 'page');
    } catch (err) {
      input.value = text;
      this.fail(err, () => void this.send(input));
    }
  }

  private fail(err: unknown, retry: () => void): void {
    const text = String((err as any)?.response?.data?.message ?? (err as any)?.message ?? err);
    this.error = { text, retry };
    this.render();
  }

  private render(): void {
    const log = this.root.querySelector('.log')!;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const rows = this.process ? chatRows(this.process.flowDataStream.items as FlowData[]) : [];
    log.innerHTML = rows.length
      ? rows
          .map((row) =>
            row.kind === 'tool'
              ? `<div class="tool" data-row="tool"><b>${esc(row.label)}</b>${row.detail ? `<span>${esc(row.detail)}</span>` : ''}${
                  row.count > 1 ? `<span>· ${row.count}</span>` : ''
                }</div>`
              : `<div class="${row.kind}" data-row="${row.kind}">${esc(row.text)}</div>`,
          )
          .join('')
      : `<div class="empty">${this.loading ? 'Opening the chat…' : this.process ? `Ask ${esc(this.agent.displayName || 'me')} anything.` : ''}</div>`;
    if (atBottom) log.scrollTop = log.scrollHeight;

    const busy = working(this.process);
    const status = this.root.querySelector('.status')!;
    status.innerHTML = this.error
      ? `<span class="err" role="alert">${esc(this.error.text)}</span><button type="button" class="btn retry" data-act="retry">Try again</button>`
      : this.process
        ? `<span>${esc(statusText(this.process))}</span>${busy ? '<button type="button" class="btn" data-act="stop">Stop</button>' : ''}`
        : '';
    (this.root.querySelector('.send') as HTMLButtonElement).disabled = !this.process;
    (this.root.querySelector('[data-act="new"]') as HTMLButtonElement).disabled = this.loading;
    this.onStatus(this.process, !!this.error);
  }

  detach(): void {
    for (const stop of this.stop.splice(0)) stop();
  }
}

/** The toggle: the agent's icon where the tag is placed; it owns the panel. */
export class FlowpadAgentElement extends HTMLElement {
  /** What the tag waits for before it looks its agent up: the SDK's own init (memoised, so the page's
   *  call and this one are the same). A seam for a page that initialises the SDK some other way. */
  static ready: () => Promise<void> = () => initSdk();

  private readonly root = this.attachShadow({ mode: 'open' });
  private panel: AgentPanel | null = null;
  private key = '';

  connectedCallback(): void {
    this.hidden = true; // until an agent is found
    void this.setup();
  }

  disconnectedCallback(): void {
    this.panel?.detach();
    this.panel?.host.remove();
    this.panel = null;
    document.documentElement.removeAttribute(OPEN_ATTR);
  }

  /** Open or close the chat. */
  toggle(open = !this.panel?.isOpen): void {
    if (!this.panel) return;
    if (open) this.panel.open();
    else this.panel.close();
    if (open) document.documentElement.setAttribute(OPEN_ATTR, 'open');
    else document.documentElement.removeAttribute(OPEN_ATTR);
    this.root.querySelector('button')?.setAttribute('aria-expanded', String(open));
    remember(this.key, open);
  }

  private async setup(): Promise<void> {
    if (!appTypeId() && !this.getAttribute('agent')) return; // opened on its own: nothing to talk to
    try {
      await FlowpadAgentElement.ready();
      const host = appTypeId() ? await resolveAppHost().catch(() => null) : null;
      const named = this.getAttribute('agent');
      const subject = host?.subject as Agent | null | undefined;
      const agent = named ? await agentNamed(named) : subject?.typeId?.type === Agent.type ? subject : null;
      const projectId =
        this.getAttribute('project') || (host?.app as { project_id?: string } | undefined)?.project_id || (agent as { project_id?: string } | null)?.project_id || '';
      if (!agent || !projectId || !this.isConnected) return;
      this.render(agent, projectId, host?.app?.typeId?.toString() ?? agent.typeId.toString());
    } catch (err) {
      console.warn('[flowpad-agent] no agent for this page', err);
    }
  }

  private render(agent: Agent, projectId: string, appKey: string): void {
    ensurePageStyles();
    const name = agent.displayName || agent.name || 'Agent';
    this.root.innerHTML = `<style>${BUTTON_CSS}${AVATAR_CSS}</style>
      <button type="button" aria-expanded="false" aria-label="${esc(name)}" title="${esc(name)}" data-testid="flowpad-agent-toggle">
        ${avatarHtml(agent)}<span class="dot none"></span>
      </button>`;
    const dot = this.root.querySelector('.dot')!;
    this.panel = new AgentPanel(
      agent,
      projectId,
      () => this.toggle(false),
      (process, failed) => {
        dot.className = `dot ${failed ? 'bad' : working(process) ? 'live' : process ? '' : 'none'}`;
      },
    );
    document.body.appendChild(this.panel.host);
    this.root.querySelector('button')!.addEventListener('click', () => this.toggle());
    this.key = `flowpad-agent:${appKey}`;
    this.hidden = false;
    if (remembered(this.key)) this.toggle(true);
  }
}

/** Register `<flowpad-agent>` once. The SDK bundle calls it on load; idempotent. */
export function defineAgentElement(): void {
  if (typeof customElements === 'undefined' || customElements.get(AGENT_PANEL_TAG)) return;
  customElements.define(AGENT_PANEL_TAG, FlowpadAgentElement);
}

defineAgentElement();
