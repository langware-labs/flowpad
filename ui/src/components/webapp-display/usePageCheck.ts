import { Project, TypeId, WebApp, type PageError, type PageReportVerdict, type ServedApp } from '@sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

/** The message the page-error reporter posts to its parent (`flow_sdk/server/reporter_relay.py`). */
export const PAGE_REPORT = 'flowpad:page-report';
/** Asks the frame's reporter to send its report again (a frame cached from an earlier mount). */
export const PAGE_REPORT_REQUEST = 'flowpad:page-report-request';

/** No report this long after the frame is shown: the page has no reporter (reporting off, a served
 *  folder) — show it as it is. */
const UNREPORTED_MS = 8000;

/**
 * - checking: the frame loads hidden until its page settles and the backend decides.
 * - ok: usable (no errors, or only ignored ones) — or the page never reported.
 * - restarting / recovering: a known `restart` fix, or the fixer agent, is at work.
 * - failed: one restart and one agent attempt did not make it usable.
 */
export type PageState = 'checking' | 'ok' | 'restarting' | 'recovering' | 'failed';

export interface PageCheck {
  state: PageState;
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
  const budget = useRef({ restart: false, agent: false });
  const decided = useRef(false);
  const agentWasRunning = useRef(false);

  const recheck = useCallback(() => {
    decided.current = false;
    setState('checking');
    setReloads((n) => n + 1);
  }, []);

  // A new app is a new check, with a fresh budget.
  useEffect(() => {
    budget.current = { restart: false, agent: false };
    decided.current = false;
    setTried([]);
    setVerdict(null);
    setState('checking');
  }, [src]);

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
    if (state !== 'checking') return;
    const ask = () => postToGuest({ type: PAGE_REPORT_REQUEST });
    ask();
    const timer = setInterval(ask, 1000);
    return () => clearInterval(timer);
  }, [state, reloads, src, postToGuest]);

  // A page that never reports is shown as it is.
  useEffect(() => {
    if (state !== 'checking') return;
    const timer = setTimeout(() => {
      if (!decided.current) setState('ok');
    }, UNREPORTED_MS);
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

  return { state, verdict, reloads, tried, retry };
}
