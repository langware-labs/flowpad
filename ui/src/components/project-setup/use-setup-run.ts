import { useCallback, useEffect, useRef, useState } from 'react';
import { Project, type SetupTreeResult } from '@sdk';
import { claimAskRun, openQuestionOf } from '@src/components/ask/ask-claims';

/** How often the run's tree is re-read while it is going. A display refresh, not a wait. */
export const SETUP_POLL_MS = 1000;

export interface SetupRun {
  /** The tree as last recorded — what is set up, what is running, what is stuck and why. */
  tree: SetupTreeResult | null;
  running: boolean;
  /** Between asking for the run and knowing it is going — a screen keeps showing the setup through it. */
  starting: boolean;
  /** The open question this screen has claimed, drawn in place. */
  questionId: string | null;
  settleQuestion: () => void;
  /** Start the setup (or join the one going) — the backend's run, so closing loses nothing. */
  start: () => Promise<void>;
}

/**
 * One project setup run, as a screen follows it: the project's whole tree, or one node of it (`root`:
 * a web app, a source) and what that node needs.
 *
 * The run is the backend's (`POST project/<id>/setup`); this claims its questions (`claimAskRun`) so
 * they are drawn here instead of sending the tab to `win/ask`, re-reads the recorded tree while it runs,
 * and calls `onSettled` once it ends. `autoStart`: start it once, the first time this turns true (a web
 * app found down). With no `projectId` it does nothing (a page that is not a project's).
 */
export function useSetupRun(
  projectId: string,
  root = '',
  onSettled?: () => void | Promise<void>,
  { autoStart = false }: { autoStart?: boolean } = {},
): SetupRun {
  const [tree, setTree] = useState<SetupTreeResult | null>(null);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [questionId, setQuestionId] = useState<string | null>(null);
  const release = useRef<() => void>(() => {});
  const autoStarted = useRef(false);
  const settled = useRef(onSettled);
  settled.current = onSettled;

  /** This screen draws `run`'s questions from now on — and picks up one already waiting. */
  const claim = useCallback((run: string) => {
    release.current();
    release.current = run ? claimAskRun(run, setQuestionId) : () => {};
    if (run) void openQuestionOf(run).then((id) => id && setQuestionId(id));
  }, []);

  // What an earlier run left — a setup reopened mid-run, or after it stopped, shows where it got to.
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    void Project.setupRun(projectId, root)
      .then((state) => {
        if (!live || !state) return;
        setTree(state.tree);
        if (state.running) {
          claim(state.run);
          setRunning(true);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId, root, claim]);

  // While it runs: re-read the tree — the next read only after the last one answered, so a slow backend
  // never stacks requests (or settles twice).
  useEffect(() => {
    if (!running) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const next = await Project.setupRun(projectId, root).catch(() => null);
      if (!live) return;
      if (next) setTree(next.tree);
      if (next && !next.running) {
        setRunning(false);
        release.current();
        setQuestionId(null);
        await settled.current?.();
        return;
      }
      timer = setTimeout(() => void poll(), SETUP_POLL_MS);
    };
    timer = setTimeout(() => void poll(), SETUP_POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [running, projectId, root]);

  useEffect(() => () => release.current(), []);

  const start = useCallback(async () => {
    if (!projectId) return;
    setStarting(true);
    try {
      const address = await Project.startSetup(projectId, root);
      // Claimed at once, so the first question is drawn here rather than sending the tab away.
      claim(address);
      setRunning(true);
    } finally {
      setStarting(false);
    }
  }, [projectId, root, claim]);

  useEffect(() => {
    if (!autoStart || autoStarted.current || running || !projectId) return;
    autoStarted.current = true;
    void start().catch(() => {});
  }, [autoStart, running, projectId, start]);

  return {
    tree,
    running,
    // Asked to start but not yet asked: still the setup's screen, never the error it is about to fix.
    starting: starting || (autoStart && !autoStarted.current && !!projectId),
    questionId,
    settleQuestion: () => setQuestionId(null),
    start,
  };
}
