import { MarkdownView } from '@src/components/markdown-view';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@src/components/ui/collapsible';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Button } from '@src/components/ui/button';
import { DiagnoseModal } from '@src/components/version-popover/diagnose-modal';
import { DiagnosisReportModal } from '@src/components/version-popover/diagnosis-report-modal';
import { sdkConfig } from '@sdk/config/index';
import { connectionManager } from '@sdk/websocket';
import { useIsDev } from '@src/components/view-mode';
import { useCloudStatus, useContext } from '@sdk/react/hooks';
import { isHubConnected } from '@sdk/services/cloud_status';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  History,
  Loader2,
  RefreshCw,
  Stethoscope,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface PypiRelease {
  version: string;
  published_at: string | null;
  yanked: boolean;
}

interface PypiInfo {
  current: string;
  latest: string | null;
  update_available: boolean;
  error: string | null;
  releases: PypiRelease[];
}

interface ReleaseInfo {
  tag: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  html_url: string | null;
}

interface HubInfo {
  version: string | null;
  deployed_at?: string | null;
  generated_at?: string | null;
}

interface VersionCheckResponse {
  pypi: PypiInfo;
  latest_release: ReleaseInfo | null;
  releases: ReleaseInfo[];
  github_error: string | null;
  hub: HubInfo | null;
}

interface ElectronAPI {
  getAppVersion?: () => Promise<string>;
  upgradeFlowpad?: () => Promise<{ success: boolean; error?: string }>;
  openExternal?: (url: string) => Promise<boolean>;
}

interface InstallVersionResponse {
  success: boolean;
  restarting?: boolean;
  reason?: string | null;
  error?: string | null;
  output?: string | null;
}

function getElectronApi(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return null;
  }
}

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateTime(iso: string | null | undefined): string | null {
  const d = parseDate(iso);
  if (!d) return null;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatAge(iso: string | null | undefined): string | null {
  const d = parseDate(iso);
  if (!d) return null;
  const ms = Date.now() - d.getTime();
  if (ms <= 0) return 'just now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function formatDateWithAge(iso: string | null | undefined, includeTime = false): string | null {
  const exact = includeTime ? formatDateTime(iso) : formatDate(iso);
  const age = formatAge(iso);
  if (exact && age) return `${exact} (${age})`;
  return exact ?? age;
}

function findReleaseByTag(releases: ReleaseInfo[], tag: string | null | undefined): ReleaseInfo | null {
  if (!tag) return null;
  const norm = tag.replace(/^v/i, '');
  return releases.find((r) => r.tag === norm) ?? null;
}

interface VersionRowProps {
  label: string;
  version: string | null;
  date?: string | null;
  badge?: string | null;
  muted?: boolean;
}

function VersionRow({ label, version, date, badge, muted }: VersionRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`flex min-w-0 flex-wrap items-baseline justify-end gap-x-2 gap-y-0.5 text-right font-mono ${muted ? 'text-muted-foreground' : ''}`}
      >
        <span className="shrink-0">{version ? `v${version}` : '—'}</span>
        {date && <span className="text-[10px] text-muted-foreground">{date}</span>}
        {badge && (
          <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
            {badge}
          </span>
        )}
      </span>
    </div>
  );
}

interface TimestampRowProps {
  label: string;
  timestamp?: string | null;
}

function TimestampRow({ label, timestamp }: TimestampRowProps) {
  const value = formatDateWithAge(timestamp, true) ?? '—';
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span
        className="max-w-[270px] text-right font-mono text-[10px] text-muted-foreground"
        title={timestamp ?? undefined}
      >
        {value}
      </span>
    </div>
  );
}

interface ReleaseNotesProps {
  title: string;
  release: ReleaseInfo | null;
}

function ReleaseNotes({ title, release }: ReleaseNotesProps) {
  const [open, setOpen] = useState(false);
  if (!release || !release.body) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-1">
      <CollapsibleTrigger className="flex w-full items-center gap-1 rounded-sm px-1 py-0.5 text-left text-[11px] text-muted-foreground hover:text-foreground">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>{title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 max-h-48 overflow-y-auto rounded-sm border bg-muted/30 px-2 py-1.5 text-[11px] leading-relaxed [&_code]:!text-[10px] [&_h1]:!my-1 [&_h1]:!border-0 [&_h1]:!pb-0 [&_h1]:!text-[12px] [&_h1]:!font-semibold [&_h2]:!my-1 [&_h2]:!border-0 [&_h2]:!pb-0 [&_h2]:!text-[12px] [&_h2]:!font-semibold [&_h3]:!my-1 [&_h3]:!text-[11px] [&_h3]:!font-semibold [&_li]:!text-[11px] [&_li]:!leading-snug [&_ol]:!my-1 [&_ol]:!pl-4 [&_p]:!my-1 [&_p]:!text-[11px] [&_p]:!leading-snug [&_pre]:!text-[10px] [&_table]:!text-[10px] [&_ul]:!my-1 [&_ul]:!pl-4">
        <MarkdownView value={release.body} compact />
      </CollapsibleContent>
    </Collapsible>
  );
}

function CopyableUrlField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }, [value]);
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="flex max-w-[200px] items-center gap-1 truncate rounded-sm bg-muted/30 px-2 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title={`Copy ${label.toLowerCase()}`}
      >
        <span className="truncate">{value}</span>
        {copied ? <Check className="h-3 w-3 shrink-0 text-green-500" /> : <Copy className="h-3 w-3 shrink-0" />}
      </button>
    </div>
  );
}

function CopyableCommand({ command }: { command: string }) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }, [command]);
  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="flex w-full items-center justify-between gap-2 rounded-md border bg-muted/30 px-2 py-1.5 font-mono text-[11px] transition-colors hover:bg-muted"
      title={t`Copy to clipboard`}
    >
      <span>{command}</span>
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
    </button>
  );
}

interface VersionPopoverProps {
  currentVersion: string;
}

export function VersionPopover({ currentVersion }: VersionPopoverProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<VersionCheckResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [electronVersion, setElectronVersion] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<InstallVersionResponse | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [diagnoseOpen, setDiagnoseOpen] = useState(false);
  const [diagReport, setDiagReport] = useState<{
    diagnosisId: string;
    conversationId?: string;
  } | null>(null);

  const isDev = useIsDev();
  const context = useContext();
  const instanceName = context?.instanceName;

  // Diagnosis runs a headless AI agent that needs an internet connection; gate the
  // trigger on cloud reachability (a good proxy for "online") so a click while
  // offline can't fail with a misleading "no transcript" error.
  const { connection } = useCloudStatus();
  const online = isHubConnected(connection.status);

  const electronApi = getElectronApi();
  const mode: 'Desktop' | 'Browser' = electronApi ? 'Desktop' : 'Browser';

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${sdkConfig.apiUrl}/api/v1/version/check`, { credentials: 'include' });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      const json = (await resp.json()) as VersionCheckResponse;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || data || loading) return;
    void fetchData();
  }, [open, data, loading, fetchData]);

  useEffect(() => {
    if (!open || !electronApi?.getAppVersion) return;
    let cancelled = false;
    electronApi
      .getAppVersion()
      .then((v) => {
        if (!cancelled) setElectronVersion(v);
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [open, electronApi]);

  const handleUpgrade = useCallback(async () => {
    if (!electronApi?.upgradeFlowpad) return;
    setUpgrading(true);
    try {
      await electronApi.upgradeFlowpad();
    } finally {
      setUpgrading(false);
    }
  }, [electronApi]);

  // Wait for the backend to go down and come back healthy, then reload so the
  // (possibly different-version) UI is reloaded fresh. The python monitor restart
  // can take a little while, so poll generously before giving up.
  const waitForRestartAndReload = useCallback(async () => {
    const healthUrl = `${sdkConfig.apiUrl}/health/status`;
    const deadline = Date.now() + 90_000;
    // Give the old server a moment to actually exit first.
    await new Promise((r) => setTimeout(r, 3000));
    while (Date.now() < deadline) {
      try {
        const r = await fetch(healthUrl, { cache: 'no-store' });
        if (r.ok) {
          window.location.reload();
          return;
        }
      } catch {
        /* server down mid-restart — keep polling */
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    setRestarting(false);
    setInstallResult({ success: false, error: t`Server did not come back. Restart Flowpad manually.` });
  }, [t]);

  const handleInstallVersion = useCallback(
    async (version: string) => {
      // Pure-SDK path: the backend reinstalls the pinned version and restarts
      // itself via the monitor. Reuse the upgrading flag for the in-flight UX.
      setUpgrading(true);
      setInstallResult(null);
      try {
        const resp = await fetch(`${sdkConfig.apiUrl}/api/v1/version/install`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version }),
        });
        const json = (await resp.json()) as InstallVersionResponse;
        if (json.success && json.restarting) {
          setRestarting(true);
          void waitForRestartAndReload();
          return;
        }
        setInstallResult(json);
      } catch (e) {
        setInstallResult({ success: false, error: e instanceof Error ? e.message : String(e) });
      } finally {
        setUpgrading(false);
      }
    },
    [waitForRestartAndReload],
  );

  const handleOpenExternal = useCallback(
    async (url: string) => {
      if (electronApi?.openExternal) {
        await electronApi.openExternal(url);
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    },
    [electronApi],
  );

  const pypi = data?.pypi;
  const githubLatest = data?.latest_release ?? null;

  const { pypiCurrentRelease, pypiLatestRelease, electronCurrentRelease, githubUpdateAvailable } = useMemo(() => {
    const releases = data?.releases ?? [];
    return {
      pypiCurrentRelease: findReleaseByTag(releases, currentVersion),
      pypiLatestRelease: pypi?.latest ? findReleaseByTag(releases, pypi.latest) : null,
      electronCurrentRelease: findReleaseByTag(releases, electronVersion),
      githubUpdateAvailable: Boolean(
        electronVersion && githubLatest && electronVersion.replace(/^v/i, '') !== githubLatest.tag,
      ),
    };
  }, [data?.releases, currentVersion, pypi?.latest, electronVersion, githubLatest]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-sm px-1.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={t`Flowpad version`}
          aria-label={t`Flowpad version`}
          data-testid="version-popover-trigger"
        >
          <span>v{currentVersion}</span>
          {(pypi?.update_available || githubUpdateAvailable) && (
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-label={t`Update available`} />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-96 p-3">
        <div className="space-y-3">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold"><Trans>Flowpad</Trans></h3>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {mode}
              </span>
              {isDev && instanceName && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {instanceName}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void fetchData()}
              disabled={loading}
              className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              title={t`Check again`}
              aria-label={t`Check again`}
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </button>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              <Trans>Couldn't check for updates: {error}</Trans>
            </div>
          )}

          {restarting && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              <span><Trans>Installing and restarting Flowpad… this can take up to a minute.</Trans></span>
            </div>
          )}

          {/* Python / PyPI section */}
          <section className="space-y-1.5">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Trans>Python (flow SDK)</Trans></h4>
              <div className="flex items-center gap-2">
                {pypi?.error && (
                  <span className="text-[10px] text-muted-foreground" title={pypi.error}>
                    <Trans>PyPI unavailable</Trans>
                  </span>
                )}
                {(pypi?.releases?.length ?? 0) > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setPendingVersion(null);
                      setPicking((p) => !p);
                    }}
                    className="flex items-center gap-1 rounded-sm px-1 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    title={t`Change the installed flow SDK version`}
                  >
                    <History className="h-3 w-3" />
                    <span><Trans>Change</Trans></span>
                  </button>
                )}
              </div>
            </div>
            <VersionRow
              label={t`Installed`}
              version={currentVersion}
              date={formatDateWithAge(pypiCurrentRelease?.published_at)}
            />
            <VersionRow
              label={t`Latest on PyPI`}
              version={pypi?.latest ?? null}
              date={formatDateWithAge(pypiLatestRelease?.published_at)}
              badge={pypi?.update_available ? t`Update available` : null}
              muted={!pypi?.update_available}
            />
            <ReleaseNotes
              title={`Notes for v${currentVersion}`}
              release={pypiCurrentRelease}
            />
            {pypi?.update_available && pypiLatestRelease && (
              <ReleaseNotes title={`Notes for v${pypi.latest}`} release={pypiLatestRelease} />
            )}
            {pypi?.update_available && (
              <div className="pt-1">
                {electronApi?.upgradeFlowpad ? (
                  <button
                    type="button"
                    onClick={() => void handleUpgrade()}
                    disabled={upgrading}
                    className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                  >
                    {upgrading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    {upgrading ? t`Upgrading…` : t`Upgrade to v${pypi.latest}`}
                  </button>
                ) : (
                  <div className="space-y-1">
                    <p className="text-[10px] text-muted-foreground"><Trans>Run from your terminal:</Trans></p>
                    <CopyableCommand command="flow upgrade" />
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => void handleOpenExternal(`https://pypi.org/project/flowpad/${pypi?.latest ?? ''}`)}
              className="flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              <span><Trans>View on PyPI</Trans></span>
            </button>

            {picking && (
              <div className="space-y-1.5 pt-1">
                <p className="text-[10px] text-muted-foreground"><Trans>Select a version to install:</Trans></p>
                <div className="max-h-48 overflow-y-auto rounded-sm border bg-muted/30 py-0.5">
                  {(pypi?.releases ?? []).map((r) => {
                    const isCurrent = r.version === currentVersion;
                    const isPending = r.version === pendingVersion;
                    return (
                      <div key={r.version}>
                        <button
                          type="button"
                          disabled={isCurrent || r.yanked || upgrading}
                          onClick={() => setPendingVersion(isPending ? null : r.version)}
                          className={`flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[11px] transition-colors disabled:cursor-default ${
                            isPending ? 'bg-accent' : 'hover:bg-accent'
                          } ${isCurrent || r.yanked ? 'opacity-60' : ''}`}
                        >
                          <span className="font-mono">v{r.version}</span>
                          <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            {formatDateWithAge(r.published_at)}
                            {isCurrent && (
                              <span className="rounded-full bg-muted px-1.5 py-0.5 font-medium"><Trans>current</Trans></span>
                            )}
                            {r.yanked && (
                              <span className="rounded-full bg-muted px-1.5 py-0.5 font-medium"><Trans>yanked</Trans></span>
                            )}
                          </span>
                        </button>
                        {isPending && (
                          <div className="space-y-1.5 border-t bg-background/60 px-2 py-2">
                            <p className="text-[11px]">
                              <Trans>Install v{r.version} and restart Flowpad?</Trans>
                            </p>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setPendingVersion(null);
                                  setInstallResult(null);
                                }}
                                disabled={upgrading}
                                className="flex-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors hover:bg-accent disabled:opacity-60"
                              >
                                <Trans>Cancel</Trans>
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleInstallVersion(r.version)}
                                disabled={upgrading}
                                className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                              >
                                {upgrading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                                {upgrading ? t`Installing…` : t`Install & restart`}
                              </button>
                            </div>
                            {installResult && !installResult.success && (
                              <div className="space-y-1.5">
                                <p className="text-[10px] text-destructive">
                                  {installResult.error ?? t`Install failed.`}
                                </p>
                                <p className="text-[10px] text-muted-foreground">
                                  <Trans>Run from your terminal, then restart Flowpad:</Trans>
                                </p>
                                <CopyableCommand command={`uv tool install flowpad==${r.version} --force`} />
                                <CopyableCommand command={`pip install flowpad==${r.version}`} />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          <div className="border-t" />

          {/* Desktop / GitHub section */}
          <section className="space-y-1.5">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Trans>Desktop version</Trans></h4>
              {data?.github_error && (
                <span className="text-[10px] text-muted-foreground" title={data.github_error}>
                  <Trans>GitHub unavailable</Trans>
                </span>
              )}
            </div>
            <VersionRow
              label={t`Installed`}
              version={electronVersion}
              date={formatDateWithAge(electronCurrentRelease?.published_at)}
              muted={!electronVersion}
            />
            <VersionRow
              label={t`Latest on GitHub`}
              version={githubLatest?.tag ?? null}
              date={formatDateWithAge(githubLatest?.published_at)}
              badge={githubUpdateAvailable ? t`Update available` : null}
              muted={!githubUpdateAvailable}
            />
            {electronCurrentRelease && electronCurrentRelease.tag !== githubLatest?.tag && (
              <ReleaseNotes
                title={`Notes for v${electronVersion}`}
                release={electronCurrentRelease}
              />
            )}
            {githubLatest && (
              <ReleaseNotes
                title={`Notes for v${githubLatest.tag}`}
                release={githubLatest}
              />
            )}
            {mode === 'Desktop' && !githubUpdateAvailable && !data?.github_error && (
              <p className="text-[10px] text-muted-foreground"><Trans>Auto-updates check hourly.</Trans></p>
            )}
            {githubLatest?.html_url && (
              <button
                type="button"
                onClick={() => void handleOpenExternal(githubLatest.html_url!)}
                className="flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ExternalLink className="h-3 w-3" />
                <span><Trans>View on GitHub</Trans></span>
              </button>
            )}
          </section>

          {data?.hub && (
            <>
              <div className="border-t" />
              <section className="space-y-1.5">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Trans>Cloud hub</Trans></h4>
                <VersionRow label={t`Hub`} version={data.hub.version} />
                <TimestampRow label={t`Deployed`} timestamp={data.hub.deployed_at} />
                <TimestampRow label={t`Generated`} timestamp={data.hub.generated_at} />
              </section>
            </>
          )}

          <div className="border-t" />
          <section className="space-y-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Trans>Connection Info</Trans></h4>
            <CopyableUrlField label={t`URL`} value={window.location.href} />
            <CopyableUrlField label={t`Connection ID`} value={connectionManager.id} />
          </section>

          {/* Toolbar */}
          <div className="-mx-3 -mb-3 mt-1 border-t px-3 pb-1 pt-2.5">
            <Button
              type="button"
              size="sm"
              className="w-full"
              disabled={!online}
              onClick={() => {
                setOpen(false);
                setDiagnoseOpen(true);
              }}
              title={online ? t`Diagnose a Flowpad issue` : t`Diagnosis needs an internet connection — you appear to be offline`}
            >
              <Stethoscope />
              <span><Trans>Diagnose</Trans></span>
            </Button>
          </div>
        </div>
      </PopoverContent>
      <DiagnoseModal
        open={diagnoseOpen}
        onClose={() => setDiagnoseOpen(false)}
        onViewDiagnosis={(d) => {
          setDiagnoseOpen(false);
          setDiagReport(d);
        }}
      />
      <DiagnosisReportModal
        open={!!diagReport}
        diagnosisId={diagReport?.diagnosisId}
        conversationId={diagReport?.conversationId}
        onClose={() => setDiagReport(null)}
      />
    </Popover>
  );
}
