import { isAppBusy, isAppShowable, TypeId, WebApp, type PageError, type PageReportVerdict, type ServedApp, type WebAppLifecycle } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { claimAskRun, openQuestionOf } from '@src/components/ask/ask-claims';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface AppLifecycle {
  /** The app's definition row, once read. */
  app: WebApp | null;
  /** THE record of the app on this machine — live: every change is pushed on the `WebApp` row. */
  record: WebAppLifecycle | null;
  loading: boolean;
  /** No such app here (removed, or a link from another machine). */
  notFound: boolean;
  /** The frame is shown iff this is true (`up` or `degraded`). */
  showable: boolean;
  /** The fixer's open question this screen claimed, drawn in place. */
  questionId: string | null;
  settleQuestion: () => void;
  /** A person's Fix it: bring the app up again, the fixer allowed to run again. */
  fixIt: () => Promise<void>;
  /** Stop the app's run (Cancel). */
  stop: () => Promise<void>;
  /** Forward one report of the page's reporter, `load_id` verbatim. */
  reportPage: (endpoint: ServedApp, errors: PageError[], settled: boolean, loadId: string) => Promise<PageReportVerdict | null>;
}

/**
 * A web app's lifecycle as a screen follows it: `useEntity(WebApp, {watch})` reads `webApp.lifecycle`, which
 * the backend computes on every GET and pushes on every change — so there is no polling here, and nothing is
 * remembered in the browser. The backend decides and recovers; the screen only says what the record says.
 *
 * Opening an app means "make it work": `autoUp` asks the backend to bring it up ONCE per app when its record
 * is neither showable nor busy. The backend owns every retry from there.
 */
const sinceOf = (rec: WebAppLifecycle | null): number => (rec?.since ? Date.parse(rec.since) || 0 : 0);

/** The later of two records of one app (by when its state changed); the pushed one on a tie. */
export function newer(live: WebAppLifecycle | null, answered: WebAppLifecycle | null): WebAppLifecycle | null {
  if (!answered) return live;
  if (!live) return answered;
  return sinceOf(answered) > sinceOf(live) ? answered : live;
}

export function useAppLifecycle(
  webappId: string | null,
  { display = '', autoUp = true }: { display?: string; autoUp?: boolean } = {},
): AppLifecycle {
  const typeId = webappId ? new TypeId(WebApp.type, webappId) : null;
  const { data: app, isLoading, notFound } = useEntity<WebApp>(typeId, { watch: true });
  const live = app?.lifecycle ?? null;

  // An action's answer shows at once; a push supersedes it as soon as it says something newer. Compared by the
  // record's own `since` (when its state last changed), never by reference — the store updates the row in place.
  const [answered, setAnswered] = useState<WebAppLifecycle | null>(null);
  const record = newer(live, answered);
  const answer = useCallback((next: WebAppLifecycle | null) => {
    if (next) setAnswered(next);
  }, []);

  const upAsked = useRef<string | null>(null);
  useEffect(() => {
    if (!autoUp || !app || !webappId || upAsked.current === webappId) return;
    if (isAppShowable(record) || isAppBusy(record)) return;
    upAsked.current = webappId;
    void app
      .up(display)
      .then(answer)
      .catch(() => null);
  }, [autoUp, app, webappId, record, display, answer]);

  // The fixer's questions are drawn here, not in a tab of their own.
  const [questionId, setQuestionId] = useState<string | null>(null);
  const agentCall = record?.agent_call ?? '';
  useEffect(() => {
    if (!agentCall) return;
    let alive = true;
    const release = claimAskRun(agentCall, setQuestionId);
    void openQuestionOf(agentCall).then((id) => {
      if (alive && id) setQuestionId(id);
    });
    return () => {
      alive = false;
      release();
      setQuestionId(null);
    };
  }, [agentCall]);

  const fixIt = useCallback(async () => {
    if (app) answer(await app.fix(display).catch(() => null));
  }, [app, display, answer]);
  const stop = useCallback(async () => {
    if (app) answer(await app.stop().catch(() => null));
  }, [app, answer]);
  const reportPage = useCallback(
    (endpoint: ServedApp, errors: PageError[], settled: boolean, loadId: string) =>
      endpoint.pageReport(errors, settled, loadId).catch(() => null),
    [],
  );

  return {
    app: app ?? null,
    record,
    loading: !!typeId && isLoading,
    notFound: !!notFound,
    showable: isAppShowable(record),
    questionId,
    settleQuestion: () => setQuestionId(null),
    fixIt,
    stop,
    reportPage,
  };
}
