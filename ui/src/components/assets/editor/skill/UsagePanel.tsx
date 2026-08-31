import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Eye, GitCompare, GraduationCap, Loader2, Play, RefreshCw } from 'lucide-react';
import { useLingui, Trans } from '@lingui/react/macro';
import { ActionInfo, FSRef, Skill, dataManager } from '@sdk';
import { getGitStatus, invalidateGitStatus } from '@src/lib/git-status-cache';

import { Checkbox } from '@src/components/ui/checkbox';
import { useAssetRevisionStatus } from '@src/hooks/use-asset-revision-status';
import { useAgentTraceDoc } from '@src/components/assets/editor/agent-trace/useAgentTraceDoc';
import { useSessionAnalyses } from '@src/components/lens-viewer/shared/transcript-features/useSessionAnalyses';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { formatTimeAgo } from '@src/utils/format-time-ago';

import { launchSessionAnalysis, launchSkillCorrect } from './skill-eval-analysis';

interface UsageSession {
  sessionId: string;
  workerType: string;
  count: number;
  lastTs: string;
  cwd?: string | null;
  /** Friendly title resolved by the backend (process name / custom title / slug). */
  name?: string | null;
}

/** Readable row label: backend title → cwd basename → short session id. */
function sessionLabel(s: UsageSession): string {
  const name = s.name?.trim();
  if (name) return name;
  const base = s.cwd?.split('/').filter(Boolean).pop();
  if (base) return base;
  return s.sessionId.slice(0, 8);
}

// Scan state cached by skill name at module scope. The editor host can hand the
// skill editor a fresh fsRef on re-render, which rebuilds the side tab and
// REMOUNTS this panel — even mid-scan. Without persisting both the results AND
// the in-flight scan, that remount wipes the spinner (looks like a flicker) and
// drops the result. The panel initializes from these and re-attaches to a
// running scan on mount, so progress and results survive remounts.
const usageScanCache = new Map<string, UsageSession[]>();
const usageScanInFlight = new Map<string, Promise<UsageSession[]>>();

/**
 * The asset improvement cycle for a skill: **usage → analyze → review → improve
 * → commit**. Scans past sessions that used this skill (FSIndexer + transcript
 * analyzer), then per selected session runs agent-trace (Analyze) and skillit
 * correct fed the verified `by_skill` findings (Improve), commits the edit, and
 * links the revision diff. Improve is gated on a clean-git asset.
 */
export function UsagePanel({ skill, skillFile }: { skill: Skill; skillFile: FSRef }) {
  const { t } = useLingui();
  const skillName = skill.name;
  // A SKILL.md ref is always a compute-node ref, which is exactly what
  // `localComputeNodeId` narrows to — no need to reach past FSRef's boundary.
  const computeNodeId = skillFile.localComputeNodeId ?? '@local';
  const workdir = skillFile.parent.path;
  const file = skillFile.path.slice(skillFile.path.lastIndexOf('/') + 1);
  const { navigation } = useDockNavigation();

  const [sessions, setSessions] = useState<UsageSession[] | null>(() => usageScanCache.get(skillName) ?? null);
  const [scanning, setScanning] = useState(() => usageScanInFlight.has(skillName));
  const [selected, setSelected] = useState<string | null>(null);
  const [doAnalyze, setDoAnalyze] = useState(true);
  const [doImprove, setDoImprove] = useState(false);
  const [running, setRunning] = useState(false);
  // Session whose analysis we kicked off and now await findings for, to chain Improve.
  const [pendingImprove, setPendingImprove] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const rev = useAssetRevisionStatus(computeNodeId, workdir, file, reload);

  // Working-tree dirtiness of THIS asset — the "clean git on asset" gate. Reuses
  // the existing git-ops `status` (the same code that manages per-asset git state).
  const [dirty, setDirty] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Reuse the shared (cached, single-flight) repo status instead of
        // firing a per-skill-tab full-tree scan; just filter for THIS file.
        const st = await getGitStatus(computeNodeId, workdir);
        if (!cancelled) setDirty((st?.files ?? []).some((f) => f.path.endsWith(file)));
      } catch {
        if (!cancelled) setDirty(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `reload` bumps after a commit to re-check dirtiness; rev.version is a
    // redundant trigger (the commit already bumps reload).
  }, [computeNodeId, workdir, file, reload]);

  const cleanGit = rev.hasRepo && dirty === false && rev.unpushed === 0;

  // Traces + verified findings for the selected session (drives Review + Improve).
  const { traces } = useSessionAnalyses(selected);
  const latestTrace = traces[0] ?? null;
  const { doc: traceDoc } = useAgentTraceDoc(latestTrace?.doc ?? null);
  const findings = useMemo(() => traceDoc?.annotations?.by_skill?.[skillName]?.findings ?? [], [traceDoc, skillName]);

  const scan = useCallback(async () => {
    // One scan per skill across all (re)mounts: reuse the in-flight promise so a
    // mid-scan remount re-attaches instead of starting over and flickering.
    let p = usageScanInFlight.get(skillName);
    if (!p) {
      p = (async () => {
        const a = new ActionInfo('asset-usage', 'compute_node', computeNodeId, 'GET');
        a.queryParameters = { skill: skillName };
        const res = await dataManager.callAction<null, { sessions: UsageSession[] }>(a);
        const found = res?.sessions ?? [];
        usageScanCache.set(skillName, found);
        return found;
      })();
      usageScanInFlight.set(skillName, p);
      void p.catch(() => undefined).finally(() => usageScanInFlight.delete(skillName));
    }
    setScanning(true);
    try {
      setSessions(await p);
    } catch (e) {
      notify.error({ title: t`Usage scan failed`, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setScanning(false);
    }
  }, [computeNodeId, skillName]);

  // After a remount, re-attach to a scan still running for this skill — scan()
  // is the single place that adopts the in-flight promise, so it just calls it.
  useEffect(() => {
    if (usageScanInFlight.has(skillName)) void scan();
  }, [skillName, scan]);

  const improve = useCallback(
    async (sid: string) => {
      if (!findings.length) {
        notify.info({ title: t`Nothing to improve`, message: t`No substantiated findings for this skill yet.` });
        return;
      }
      await launchSkillCorrect({ targetSkill: skill, sessionId: sid, findings });
    },
    [findings, skill],
  );

  const commit = useCallback(async () => {
    try {
      const a = new ActionInfo('commit-asset', 'compute_node', computeNodeId, 'POST');
      a.bodyParameters = { workdir, file };
      const r = await dataManager.callAction<null, { committed: boolean; version?: number }>(a);
      if (r?.committed) {
        notify.success({ title: t`Committed ${skillName} v${r.version}` });
        // The commit changed the working tree — drop the cached status so the
        // reload-triggered dirty re-check (and the footer pill) refetch fresh.
        invalidateGitStatus(computeNodeId, workdir);
        setReload((x) => x + 1);
        rev.refresh();
      } else {
        notify.info({ title: t`Nothing to commit`, message: t`The asset matches HEAD.` });
      }
    } catch (e) {
      notify.error({ title: t`Commit failed`, message: e instanceof Error ? e.message : String(e) });
    }
  }, [computeNodeId, workdir, file, skillName, rev]);

  const run = useCallback(async () => {
    if (!selected) return;
    const s = sessions?.find((x) => x.sessionId === selected);
    if (!s) return;
    setRunning(true);
    try {
      if (doAnalyze) await launchSessionAnalysis(s.sessionId, s.workerType);
      if (doImprove && cleanGit) {
        // Chain: if we just launched analysis, wait for its trace's findings; else go now.
        if (doAnalyze) setPendingImprove(s.sessionId);
        else await improve(s.sessionId);
      } else if (doImprove && !cleanGit) {
        notify.warning({
          title: t`Improve skipped`,
          message: t`Commit/clean this asset first — Improve runs only on a clean-git asset.`,
        });
      }
    } finally {
      setRunning(false);
    }
  }, [selected, sessions, doAnalyze, doImprove, cleanGit, improve]);

  // Auto-chain: once the pending session's analysis produces findings, improve.
  useEffect(() => {
    if (pendingImprove && pendingImprove === selected && findings.length && cleanGit) {
      setPendingImprove(null);
      void improve(selected);
    }
  }, [pendingImprove, selected, findings, cleanGit, improve]);

  const openTrace = useCallback(() => {
    if (latestTrace) navigation.openDock(latestTrace.editorDockPointer);
  }, [latestTrace, navigation]);

  return (
    <div className="flex h-full flex-col overflow-hidden text-[12px]">
      {/* Scan + stage controls */}
      <div className="shrink-0 space-y-2 border-b border-border p-2">
        <div className="flex items-center justify-between">
          <span className="font-medium">
            <Trans>Usage & improvement</Trans>
          </span>
          <button
            type="button"
            onClick={() => void scan()}
            disabled={scanning}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {scanning ? t`Scanning ${skillName} usage…` : t`Scan usage`}
          </button>
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          <label className="flex items-center gap-1.5">
            <Checkbox checked={doAnalyze} onCheckedChange={(v) => setDoAnalyze(!!v)} /> <Trans>Analyze</Trans>
          </label>
          <label
            className={cn('flex items-center gap-1.5', !cleanGit && 'opacity-50')}
            title={cleanGit ? undefined : t`Commit/clean this asset to enable Improve`}
          >
            <Checkbox checked={doImprove} disabled={!cleanGit} onCheckedChange={(v) => setDoImprove(!!v)} />{' '}
            <Trans>Improve</Trans>
          </label>
          <button
            type="button"
            onClick={() => void run()}
            disabled={!selected || running || (!doAnalyze && !doImprove)}
            className="ms-auto flex items-center gap-1 rounded bg-primary px-2 py-1 text-[11px] text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {running || pendingImprove ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            <Trans>Run</Trans>
          </button>
        </div>
        {!cleanGit && rev.hasRepo && (
          <p className="text-[10px] text-muted-foreground">
            {dirty ? 'Asset has uncommitted changes' : rev.unpushed > 0 ? `${rev.unpushed} unpushed` : ''} — Improve
            runs only on a clean-git asset.
          </p>
        )}
      </div>

      {/* Sessions */}
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {scanning ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>
              <Trans>Scanning sessions for "{skillName}"…</Trans>
            </span>
            <span className="text-[10px]">
              <Trans>FSIndexer + transcript analyzer · this can take a few seconds</Trans>
            </span>
          </div>
        ) : sessions === null ? (
          <p className="p-3 text-center text-muted-foreground">
            <Trans>Scan to find sessions that used this skill.</Trans>
          </p>
        ) : sessions.length === 0 ? (
          <p className="p-3 text-center text-muted-foreground">
            <Trans>No past sessions used "{skillName}".</Trans>
          </p>
        ) : (
          <>
            <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              {sessions.length} session{sessions.length === 1 ? '' : 's'} used this skill
            </p>
            {sessions.map((s) => {
              const isSel = s.sessionId === selected;
              return (
                <button
                  key={s.sessionId}
                  type="button"
                  onClick={() => setSelected(s.sessionId)}
                  title={s.sessionId}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-start hover:bg-muted',
                    isSel && 'bg-muted',
                  )}
                >
                  <Activity className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[11px]">{sessionLabel(s)}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{s.count}×</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{formatTimeAgo(s.lastTs) ?? ''}</span>
                </button>
              );
            })}
          </>
        )}
      </div>

      {/* Selected-session actions */}
      {selected && (
        <div className="shrink-0 space-y-2 border-t border-border p-2">
          {latestTrace ? (
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">
                Trace: <span className="font-medium text-foreground">{latestTrace.verdict ?? '—'}</span> ·{' '}
                {findings.length} finding{findings.length === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                onClick={openTrace}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted"
              >
                <Eye className="h-3.5 w-3.5" /> <Trans>Review</Trans>
              </button>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              <Trans>No analysis yet — Analyze to produce a trace.</Trans>
            </p>
          )}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() =>
                void launchSessionAnalysis(
                  selected,
                  sessions?.find((x) => x.sessionId === selected)?.workerType ?? 'claude',
                )
              }
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] hover:bg-muted"
            >
              <Activity className="h-3.5 w-3.5" /> <Trans>Analyze</Trans>
            </button>
            <button
              type="button"
              onClick={() => void improve(selected)}
              disabled={!cleanGit || !findings.length}
              title={
                !cleanGit ? t`Asset must be clean-git` : !findings.length ? t`No substantiated findings` : undefined
              }
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
            >
              <GraduationCap className="h-3.5 w-3.5" /> <Trans>Improve</Trans>
            </button>
            <button
              type="button"
              onClick={() => void commit()}
              disabled={dirty !== true}
              title={dirty ? t`Version-bump + commit the asset` : t`No uncommitted changes`}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
            >
              <GitCompare className="h-3.5 w-3.5" /> <Trans>Commit</Trans>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
