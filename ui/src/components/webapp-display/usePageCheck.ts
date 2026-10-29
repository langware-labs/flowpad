import { Project, TypeId, WebApp, type PageError, type PageReportVerdict, type ServedApp } from '@sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

/** The message the page-error reporter posts to its parent (`flow_sdk/server/reporter_relay.py`). */
export const PAGE_REPORT = 'flowpad:page-report';
/** Asks the frame's reporter to send its report again (a frame cached from an earlier mount). */
export const PAGE_REPORT_REQUEST = 'flowpad:page-report-request';

/** No usable answer this long after the frame is shown — no reporter (reporting off), or the backend
 *  never judged the report — show the page as it is. */
const UNREPORTED_MS = 8000;

/**
 * - checking: the frame loads hidden until its page settles and the backend decides.
 * - ok: usable (no errors, or only ignored ones) — or the page never reported.
 * - restarting / recovering: a known `restart` fix, or the fixer agent, is at work.
 * - failed: one restart and one agent attempt did not make it usable.
 */
export type PageState = 'checking' | 'ok' | 'restarting' | 'recovering' | 'failed';

/** What the check is doing right now, for the one-line detail under its step. */
export type CheckPhase = 'loading' | 'deciding';

export interface PageCheck {
  state: PageState;
  /** While `checking`: waiting for the page's report, or the backend judging it. */
  phase: CheckPhase;
  /** When this check started (ms epoch), for the elapsed seconds on screen. */
  checkStartedAt: number;
  /** The last decision, for the screens: what the page threw and what each error means. */
  verdict: PageReportVerdict | null;
  /** Bumped to reload the frame after a restart. */
  reloads: number;
  /** What has been tried for this failure, in order, for the "could not recover" screen. */
  tried: string[];
  retry: () => void;
}

interface Options {
  endpoint: ServedApp | null;
  /** The frame's guest test: a report counts only from this display's own frame. */
  isGuest: (source: MessageEventSource | null) => boolean;
  /** Post to the frame's page (the reporter listens for `PAGE_REPORT_REQUEST`). */
  postToGuest: (message: unknown) => void;
  /** Start the fixer agent for these errors (`useWebappFix`); its end calls `agentDone`. */
  startAgent: (verdict: PageReportVerdict) => void;
  agentRunning: boolean;
  /** Identity of the app being shown: a new one starts a new check. */
  src: string;
}

/**
 * The fast lane and the recovery lanes of a web app on screen, in one place.
 *
 * The page reports itself (the relay's reporter); the backend decides each error against the app's
 * `setup/webapp_errors.json`. Usable → show. A failure whose every error has the `restart` fix →
 * restart the server (no agent). Anything else → the fixer agent, once. Still failing → failed.
 */
export function usePageCheck({ endpoint, isGuest, postToGuest, startAgent, agentRunning, src }: Options): PageCheck {
  const [state, setState] = useState<PageState>('checking');
  const [verdict, setVerdict] = useState<PageReportVerdict | null>(null);
  const [reloads, setReloads] = useState(0);
  const [tried, setTried] = useState<string[]>([]);
  const [phase, setPhase] = useState<CheckPhase>('loading');
  const [checkStartedAt, setCheckStartedAt] = useState(() => Date.now());
  // Only a dev server sits behind the error reporter (`server/reporter_relay`); a served folder never
  // reports, so there is nothing to wait for — show it at once.
  const reports = endpoint?.backend?.type === 'proxy';
  const budget = useRef({ restart: false, agent: false });
  const decided = useRef(false);
  const agentWasRunning = useRef(false);
  // This display reloaded the frame itself: the new page reports on its own, and asking would reach the
  // OLD page first (its stale report) while the reload is in flight.
  const reloadedHere = useRef(false);

  const recheck = useCallback(() => {
    reloadedHere.current = true;
    decided.current = false;
    setPhase('loading');
    setCheckStartedAt(Date.now());
    setState('checking');
    setReloads((n) => n + 1);
  }, []);

  // A new app is a new check, with a fresh budget.
  useEffect(() => {
    budget.current = { restart: false, agent: false };
    decided.current = false;
    reloadedHere.current = false;
    setTried([]);
    setVerdict(null);
    setPhase('loading');
    setCheckStartedAt(Date.now());
    setState('checking');
  }, [src]);

  useEffect(() => {
    if (state === 'checking' && endpoint && !reports) {
      decided.current = true;
      setState('ok');
    }
  }, [state, endpoint, reports]);

  const recover = useCallback(
    async (found: PageReportVerdict) => {
      const toRecover = found.decisions.filter((d) => d.action === 'recover');
      const restartFixes = toRecover.length > 0 && toRecover.every((d) => d.fix === 'restart');
      if (restartFixes && !budget.current.restart && endpoint?.project_id) {
        budget.current.restart = true;
        setTried((t) => [...t, 'restart']);
        setState('restarting');
        const app = found.webapp_id ? await WebApp.getById<WebApp>(new TypeId(found.webapp_id).id) : null;
        if (app?.name) await Project.stopApp(endpoint.project_id, app.name, true, true).catch(() => null);
        recheck();
        return;
      }
      if (!budget.current.agent) {
        budget.current.agent = true;
        setTried((t) => [...t, 'agent']);
        setState('recovering');
        startAgent(found);
        return;
      }
      setState('failed');
    },
    [endpoint, recheck, startAgent],
  );

  // The page's report: the first settled one of each load decides.
  useEffect(() => {
    const decide = async (event: MessageEvent) => {
      const data = event.data as { type?: string; errors?: PageError[]; settled?: boolean } | null;
      if (!data || data.type !== PAGE_REPORT || !data.settled || !isGuest(event.source)) return;
      if (decided.current || !endpoint) return;
      decided.current = true;
      setPhase('deciding');
      const found = await endpoint.pageReport(data.errors ?? [], true).catch(() => null);
      if (!found) {
        setState('ok'); // the backend could not decide: never hide a page over it
        return;
      }
      setVerdict(found);
      if (found.usable) setState('ok');
      else void recover(found);
    };
    const onMessage = (event: MessageEvent) => void decide(event);
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [endpoint, isGuest, recover]);

  // While checking, ask the frame for its report: a frame this mount did not load reports only when asked.
  useEffect(() => {
    if (state !== 'checking' || reloadedHere.current) return;
    const ask = () => {
      if (!decided.current) postToGuest({ type: PAGE_REPORT_REQUEST });
    };
    ask();
    const timer = setInterval(ask, 1000);
    return () => clearInterval(timer);
  }, [state, reloads, src, postToGuest]);

  // A page that never reports — or whose report the backend never answers — is shown as it is. The
  // report marks the check decided before the backend answers, so this must not wait on `decided`.
  useEffect(() => {
    if (state !== 'checking') return;
    const timer = setTimeout(() => setState((now) => (now === 'checking' ? 'ok' : now)), UNREPORTED_MS);
    return () => clearTimeout(timer);
  }, [state, reloads, src]);

  // The agent's end is a recheck: its own word is not the verdict, the page's next report is.
  useEffect(() => {
    if (agentRunning) agentWasRunning.current = true;
    else if (agentWasRunning.current) {
      agentWasRunning.current = false;
      recheck();
    }
  }, [agentRunning, recheck]);

  const retry = useCallback(() => {
    budget.current = { restart: false, agent: false };
    setTried([]);
    recheck();
  }, [recheck]);

  return { state, phase, checkStartedAt, verdict, reloads, tried, retry };
}
