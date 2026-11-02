import { MarkdownView } from '@src/components/markdown-view';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@src/components/ui/collapsible';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Button } from '@src/components/ui/button';
import { useCopied } from '@src/components/ui/copy-button';
import { DesktopUpdateModal, type DesktopUpdateRequiredInfo } from '@src/components/version-popover/desktop-update-modal';
import { UpdateReadyModal, type UpdateReadyInfo } from '@src/components/version-popover/update-ready-modal';
import { DiagnoseModal } from '@src/components/version-popover/diagnose-modal';
import { DiagnosisReportModal } from '@src/components/version-popover/diagnosis-report-modal';
import { VersionChip } from '@src/components/version-popover/version-chip';
import { notify } from '@src/notifications/notify';
import apiClient from '@sdk/client';
import { connectionManager } from '@sdk/websocket';
import { useIsDev } from '@src/components/view-mode';
import { usePreference } from '@src/hooks/use-preference';
import { instancePreferences, PrefKey } from '@sdk';
import { useContext } from '@sdk/react/hooks';
import { RuntimeLabel } from '@src/components/top-nav-bar/RuntimeChip';
import { useMinimizeOnClose } from '@src/hooks/use-minimize-on-close';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  History,
  KeyRound,
  Loader2,
  RefreshCw,
  Stethoscope,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { openLlmSources } from '@src/components/llm-sources/llm-sources-pointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

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
  /** When THIS machine installed the running flow SDK — a LOCAL fact, so it
   *  sits beside `hub` rather than inside `pypi`. Null for a source checkout. */
  installed_at: string | null;
  hub: HubInfo | null;
}

/** Desktop update status as the Electron shell reports it ('update:get-info'). */
interface DesktopUpdateInfo {
  installed: string;
  state: 'available' | 'current' | 'unknown' | 'unsupported';
  available: string | null;
  downloadState: 'idle' | 'downloading' | 'ready' | 'installing';
  /** Does the build on the feed satisfy the latest engine's min-desktop floor? null = no floor/unknown. */
  meetsEngineFloor?: boolean | null;
  /** An install failed after the updater handed over: only a restart of FlowPad can apply it now. */
  restartRequired?: boolean;
  /** Does a downloaded update install when FlowPad quits? (Not on deb/rpm — absent means yes.) */
  installsOnQuit?: boolean;
}

/** Engine (PyPI) compat pre-flight, computed by the shell from the candidate wheel's metadata. */
interface EnginePreflight {
  installed: string | null;
  latest: string | null;
  updateAvailable: boolean;
  latestMinDesktop: string | null;
  /** null = could not be decided (offline / no metadata) — proceed; the install gates decide. */
  latestCompatible: boolean | null;
  newestCompatible: string | null;
}

/** Outcome of a panel-initiated coordinated update resumed after the desktop restart. */
interface ResumedUpdate {
  /** 'coordinated': the desktop was updated and the flow SDK followed it; 'engine': a flow SDK
   *  upgrade from this panel, the desktop untouched. Absent on older shells (read as coordinated). */
  kind?: 'coordinated' | 'engine';
  success: boolean;
  engineVersion: string | null;
  desktopVersion: string;
  /** On failure: the previous flow SDK was put back. */
  restored?: boolean;
  error?: string;
}

interface UpdateInfo {
  desktop: DesktopUpdateInfo;
  engine: EnginePreflight | null;
  busy: boolean;
  /** A running desktop/engine pair the contract forbids (repair offline/held/declined at launch). */
  pairWarning?: string | null;
  /** The engine update staged in the background (prepareEngine) — the row's snapshot. */
  engineUpdate?: EngineUpdateState;
}

/** An engine update staged in the background ('engine-update-state'). */
interface EngineUpdateState {
  state: 'idle' | 'preparing' | 'ready' | 'error';
  version?: string | null;
  /** Staged for a coordinated update: the NEW desktop installs it (the desktop row owns that flow). */
  coordinated?: boolean;
  error?: string | null;
  /** Started by an automatic check, not a click: the row shows it, but nothing is toasted. */
  background?: boolean;
}

/** Live desktop-update progress pushed by the shell ('desktop-update-state'). */
interface DesktopUpdatePush {
  state: 'downloading' | 'ready' | 'installing' | 'error';
  percent?: number;
  version?: string;
  error?: string;
  /** Started by an automatic check, not a click: the row shows it, but a failure is not toasted. */
  background?: boolean;
  /** The APPLY failed (quitAndInstall), not the download: Retry re-applies the landed artifact. */
  apply?: boolean;
  /** The install failed after the updater handed over: the way forward is restarting FlowPad. */
  restart?: boolean;
}

interface UpdateActionResult {
  started: boolean;
  ready?: boolean;
  version?: string;
  reason?: string;
  /** update:both only — null when no newer flow SDK fits the target desktop (the desktop goes alone). */
  engineVersion?: string | null;
}

interface ElectronAPI {
  getAppVersion?: () => Promise<string>;
  upgradeFlowpad?: (opts?: {
    direct?: boolean;
    version?: string;
  }) => Promise<{ success: boolean; error?: string; desktopUpdatePending?: boolean }>;
  openExternal?: (url: string) => Promise<boolean>;
  getUpdateInfo?: (opts?: { fresh?: boolean }) => Promise<UpdateInfo>;
  takeResumedUpdate?: () => Promise<ResumedUpdate | null>;
  downloadDesktopUpdate?: () => Promise<UpdateActionResult>;
  applyDesktopUpdate?: () => Promise<UpdateActionResult>;
  restartApp?: () => Promise<{ started: boolean }>;
  prepareEngine?: (opts?: { version?: string }) => Promise<UpdateActionResult & { desktopUpdatePending?: boolean }>;
  applyEngineUpdate?: () => Promise<UpdateActionResult & { error?: string }>;
  cancelEngineUpdate?: () => Promise<{ cancelled: boolean }>;
  onEngineUpdateState?: (cb: (s: EngineUpdateState) => void) => () => void;
  onUpdateReady?: (cb: (info: UpdateReadyInfo) => void) => () => void;
  panelReady?: () => Promise<boolean>;
  getPairWarning?: () => Promise<string | null>;
  cancelDesktopDownload?: () => Promise<{ cancelled: boolean }>;
  updateBoth?: (engineVersion: string) => Promise<UpdateActionResult>;
  onDesktopUpdateState?: (callback: (state: DesktopUpdatePush) => void) => () => void;
  onEngineUpdateResumed?: (callback: (result: ResumedUpdate) => void) => () => void;
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

/** PyPI publish date for a flow SDK version.
 *
 *  Deliberately separate from `findReleaseByTag`: that one searches the GitHub
 *  Releases list, which is the DESKTOP app's tags (v0.2.41…). Asking it for a
 *  flow SDK version (v0.2.157) never matches, which is why both PyPI rows used
 *  to render a blank date. PyPI ships its own per-version publish times. */
function findPypiRelease(releases: PypiRelease[] | undefined, version: string | null | undefined): PypiRelease | null {
  if (!version) return null;
  const norm = version.replace(/^v/i, '');
  return (releases ?? []).find((r) => r.version === norm) ?? null;
}

interface VersionRowAction {
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  testId: string;
}

interface VersionRowProps {
  label: string;
  version: string | null;
  date?: string | null;
  badge?: string | null;
  muted?: boolean;
  /** Next to the badge: an update that is downloaded and checked installs from here, any time. */
  action?: VersionRowAction | null;
}

function VersionRow({ label, version, date, badge, muted, action }: VersionRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`flex min-w-0 flex-wrap items-baseline justify-end gap-x-2 gap-y-0.5 text-end font-mono ${muted ? 'text-muted-foreground' : ''}`}
      >
        <span className="shrink-0">{version ? `v${version}` : '—'}</span>
        {date && <span className="text-[10px] text-muted-foreground">{date}</span>}
        {badge && (
          <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
            {badge}
          </span>
        )}
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            disabled={action.disabled}
            title={action.title}
            data-testid={action.testId}
            className="rounded-full bg-primary px-2 py-0.5 font-sans text-[10px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {action.label}
          </button>
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
        className="max-w-[270px] text-end font-mono text-[10px] text-muted-foreground"
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
      <CollapsibleTrigger className="flex w-full items-center gap-1 rounded-sm px-1 py-0.5 text-start text-[11px] text-muted-foreground hover:text-foreground">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3 rtl:-scale-x-100" />}
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

/** A one-line command drawn as a button — shared by the copy-only and the runnable command. */
export const COMMAND_BUTTON_CLASS =
  'flex w-full items-center justify-between gap-2 rounded-md border bg-muted/30 px-2 py-1.5 font-mono text-[11px] transition-colors hover:bg-muted';

export function CopyableCommand({ command }: { command: string }) {
  const { t } = useLingui();
  const { copied, copy } = useCopied();
  return (
    <button
      type="button"
      onClick={() => void copy(command).catch(() => undefined)}
      className={COMMAND_BUTTON_CLASS}
      title={t`Copy to clipboard`}
    >
      <span className="break-all text-start">{command}</span>
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
    </button>
  );
}

/** A shell error can carry uv's whole output: a toast shows its first line (the log keeps the rest). */
function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? text;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

interface VersionPopoverProps {
  currentVersion: string;
}

export function VersionPopover({ currentVersion }: VersionPopoverProps) {
  const { navigation } = useDockNavigation();
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  // Read by the shell's push listener (mounted once): is anyone looking at the panel right now?
  const openRef = useRef(false);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  // Closing the popover genie-minimizes it into the version button.
  const { sourceRef, targetRef, handleOpenChange } = useMinimizeOnClose(setOpen);
  const [data, setData] = useState<VersionCheckResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [electronVersion, setElectronVersion] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  // The Upgrade click's pre-flight (nothing is installed yet): the button says "Checking…", not "Upgrading…".
  const [upgradeChecking, setUpgradeChecking] = useState(false);
  // The engine staged in the background (prepareEngine), and the "ready — restart now or later?" dialog.
  const [enginePush, setEnginePush] = useState<EngineUpdateState | null>(null);
  const [readyAsk, setReadyAsk] = useState<UpdateReadyInfo | null>(null);
  const [readyBusy, setReadyBusy] = useState(false);
  const [readyError, setReadyError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<InstallVersionResponse | null>(null);
  const [restarting, setRestarting] = useState(false);
  // Desktop-update flow (FLOWPAD-2310): the shell's status snapshot, the live progress push, the
  // "Desktop Update Required" popup, and errors from panel-initiated update actions.
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [desktopPush, setDesktopPush] = useState<DesktopUpdatePush | null>(null);
  const [desktopActionNote, setDesktopActionNote] = useState<string | null>(null);
  // One desktop action (Download / Update Now / Retry) at a time: a double click used to start a
  // second call, which the shell answered with a false "another update is already in progress".
  const [desktopActionBusy, setDesktopActionBusy] = useState(false);
  const desktopActionBusyRef = useRef(false);
  const runDesktopAction = useCallback(async (action: () => Promise<void>) => {
    if (desktopActionBusyRef.current) return;
    desktopActionBusyRef.current = true;
    setDesktopActionBusy(true);
    try {
      await action();
    } finally {
      desktopActionBusyRef.current = false;
      setDesktopActionBusy(false);
    }
  }, []);
  const [compatInfo, setCompatInfo] = useState<DesktopUpdateRequiredInfo | null>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [desktopActionError, setDesktopActionError] = useState<string | null>(null);
  const [diagnoseOpen, setDiagnoseOpen] = useState(false);
  const [diagReport, setDiagReport] = useState<{
    diagnosisId: string;
    conversationId?: string;
  } | null>(null);

  const isDev = useIsDev();
  const context = useContext();
  const instanceName = context?.instanceName;

  const electronApi = getElectronApi();
  const mode: 'Desktop' | 'Browser' = electronApi ? 'Desktop' : 'Browser';

  // Dev-only: which SPA page the local server renders. The backend reads this
  // preference at bootstrap to set supported_pages, so changing it needs a full
  // reload to re-bootstrap. Flush the debounced save first so the reload sees it.
  const [appPage] = usePreference<string>(PrefKey.APP_PAGE);
  const [switchingPage, setSwitchingPage] = useState(false);
  const selectAppPage = useCallback(
    async (page: 'desk' | 'hub') => {
      if (page === (appPage ?? 'desk') || switchingPage) return;
      setSwitchingPage(true);
      instancePreferences.set(PrefKey.APP_PAGE, page);
      await instancePreferences.saveJson();
      window.location.reload();
    },
    [appPage, switchingPage],
  );

  const fetchData = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiClient.get<VersionCheckResponse>(`/api/v1/version/check${refresh ? '?refresh=true' : ''}`));
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

  /** Why the shell refused a panel update action, as user-readable text. */
  const updateRefusalText = useCallback(
    (reason: string | undefined): string => {
      switch (reason) {
        case 'busy':
          return t`Another update is already in progress.`;
        case 'unsupported':
          return t`Desktop updates are not available for this build.`;
        case 'no-update':
          return t`No desktop update is available.`;
        case 'not-prepared':
          return t`The update is no longer prepared — start it again.`;
        case 'not-newer':
          return t`That flow SDK version is not newer than the installed one.`;
        case 'restart-required':
          return t`Restart FlowPad to finish installing the update.`;
        case 'not-downloaded':
          return t`The update has not finished downloading yet.`;
        default:
          return t`The update could not be started${reason ? ` (${reason})` : ''}.`;
      }
    },
    [t],
  );

  /** One-shot outcome of an update this launch finished (pushed at startup, or pulled at mount).
   *  Both channels can deliver the same outcome — the push for a panel that was already mounted, the
   *  'update:take-resumed' pull for one that mounted late — so the ref shows it exactly once. */
  const resumedShownRef = useRef<string | null>(null);
  const showResumed = useCallback(
    (r: ResumedUpdate) => {
      const key = `${r.kind ?? 'coordinated'}:${r.desktopVersion}->${r.engineVersion}:${String(r.success)}`;
      if (resumedShownRef.current === key) return;
      resumedShownRef.current = key;
      const engineOnly = r.kind === 'engine';
      const reason = r.error ? `: ${firstLine(r.error)}.` : '.';
      if (r.success) {
        notify.success({
          id: 'engine-update-resumed',
          title: t`FlowPad updated`,
          message: engineOnly
            ? r.engineVersion
              ? t`flow SDK v${r.engineVersion} is installed.`
              : t`The flow SDK is up to date.`
            : t`Desktop v${r.desktopVersion}, flow SDK v${r.engineVersion}.`,
        });
      } else {
        // The only feedback that the update the user agreed to did not finish — toast in every mode.
        const target = r.engineVersion ? t` to v${r.engineVersion}` : '';
        notify.error({
          id: 'engine-update-resumed',
          title: t`flow SDK update failed`,
          message: engineOnly
            ? r.restored
              ? t`The flow SDK update${target} failed${reason} Your previous version was restored.`
              : t`The flow SDK update${target} failed${reason}`
            : t`Desktop updated to v${r.desktopVersion}, but the flow SDK update${target} failed${reason} FlowPad will offer it again.`,
          forceToast: true,
        });
      }
    },
    [t],
  );

  const refreshUpdateInfo = useCallback(async (opts?: { fresh?: boolean }): Promise<UpdateInfo | null> => {
    if (!electronApi?.getUpdateInfo) return null;
    try {
      const info = await electronApi.getUpdateInfo(opts);
      setUpdateInfo(info);
      // The shell's snapshot is authoritative when nothing moves: a stale push (a failed or
      // cancelled download's last 'downloading'/'error') must not outlive it. And a 'downloading'
      // push specifically dies the moment the snapshot says the download is OVER — "Later" at the
      // native prompt used to leave the row on "Downloading… 100%" with no buttons.
      if (info.desktop.downloadState === 'idle') setDesktopPush(null);
      else if (info.desktop.downloadState !== 'downloading') {
        setDesktopPush((p) => (p && p.state === 'downloading' ? null : p));
      }
      return info;
    } catch {
      return null;
    }
  }, [electronApi]);

  // Ask the shell for update status when the popover opens (it re-checks the feed only when idle).
  useEffect(() => {
    if (!open) return;
    void refreshUpdateInfo();
  }, [open, refreshUpdateInfo]);

  // Live progress while a desktop update downloads/installs. Mounted once (the popover component
  // lives in the footer), so a download finishing while the popover is closed still lands here.
  useEffect(() => {
    const dispose = electronApi?.onDesktopUpdateState?.((s) => {
      setDesktopPush(s);
      if (s.state !== 'error') setDesktopActionError(null);
      if (s.state === 'ready' || s.state === 'installing' || s.state === 'error') notify.dismiss('desktop-update-download');
      // A failure while the popover is CLOSED would otherwise surface nowhere — and a later open reads
      // an idle snapshot and clears it — while the pending desktop keeps holding flow SDK updates.
      if (s.state === 'error' && !s.background && !openRef.current) {
        notify.error({
          id: 'desktop-update-failed',
          title: t`The desktop update failed`,
          message: s.error ? firstLine(s.error) : t`Open the version panel to try again.`,
          forceToast: true,
        });
      }
    });
    return dispose;
  }, [electronApi, t]);

  // The engine staging in the background (every engine update): the row's progress, and — when the panel
  // is closed (the native dialog's Upgrade, the popup) — a toast so the click visibly did something.
  useEffect(() => {
    const dispose = electronApi?.onEngineUpdateState?.((s) => {
      setEnginePush(s);
      if (s.state === 'preparing' && !s.coordinated && !s.background && !openRef.current) {
        notify.info({
          id: 'engine-update-prepare',
          title: s.version ? t`Downloading flow SDK v${s.version}` : t`Downloading the flow SDK update`,
          message: t`FlowPad keeps working meanwhile, and asks before switching to it.`,
        });
      }
      if (s.state !== 'preparing') notify.dismiss('engine-update-prepare');
      if (s.state === 'error' && !s.coordinated && !s.background && !openRef.current) {
        notify.error({
          id: 'engine-update-prepare-failed',
          title: t`The flow SDK update could not be downloaded`,
          message: s.error ? firstLine(s.error) : t`Open the version panel to try again.`,
          forceToast: true,
        });
      }
    });
    return dispose;
  }, [electronApi, t]);

  // Everything is staged: the one question — restart now or later.
  useEffect(() => {
    const dispose = electronApi?.onUpdateReady?.((info) => {
      notify.dismiss('desktop-update-download');
      setReadyError(null);
      setReadyAsk(info);
    });
    // Tell the shell this UI shows that dialog: without it the shell asks natively (an older UI).
    void electronApi?.panelReady?.().catch(() => {});
    return dispose;
  }, [electronApi]);

  // A panel-initiated coordinated update resumed by this launch: report its outcome.
  useEffect(() => {
    const dispose = electronApi?.onEngineUpdateResumed?.((r) => showResumed(r));
    return dispose;
  }, [electronApi, showResumed]);

  // …and PULL it once at mount: the startup push can beat the listener above, and 'update:get-info'
  // only runs when the popover opens — without this, a failed resumed update stayed silent until then.
  useEffect(() => {
    let cancelled = false;
    void electronApi?.takeResumedUpdate?.()
      .then((r) => {
        if (r && !cancelled) showResumed(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [electronApi, showResumed]);

  // An incompatible desktop/engine pair is RUNNING (the repair could not run at launch): say so at mount,
  // not only inside the popover — the app starts anyway, so nothing else tells the user.
  useEffect(() => {
    let cancelled = false;
    void electronApi?.getPairWarning?.()
      .then((message) => {
        if (message && !cancelled) {
          notify.warning({
            id: 'engine-pair-warning',
            title: t`FlowPad Desktop and the flow SDK do not match`,
            message: firstLine(message),
            forceToast: true,
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [electronApi, t]);

  /** The "Desktop Update Required" popup's facts — identical for both ways in (the pre-flight
   *  verdict and the shell's desktop-first refusal). A feed build below the engine's floor is
   *  "no suitable build yet", not an offer; `newestCompatible` is the popup's fallback: the newest
   *  flow SDK THIS desktop can run (named only when it actually moves the install forward). */
  const buildCompatInfo = useCallback(
    (info: UpdateInfo | null, engine: EnginePreflight | null): DesktopUpdateRequiredInfo => ({
      engineTarget: engine?.latest ?? data?.pypi?.latest ?? null,
      minDesktop: engine?.latestMinDesktop ?? null,
      desktopInstalled: info?.desktop.installed ?? electronVersion,
      desktopAvailable:
        info?.desktop.state === 'available' && info.desktop.meetsEngineFloor !== false
          ? info.desktop.available
          : null,
      newestCompatible:
        engine?.newestCompatible && engine.newestCompatible !== currentVersion ? engine.newestCompatible : null,
      checkFailed: info ? info.desktop.state === 'unknown' : true,
      // Opened only because a desktop update is PENDING (the latest engine itself is compatible):
      // the popup must say that, not claim a floor the installed desktop actually meets.
      pendingOnly: engine ? engine.latestCompatible !== false : true,
    }),
    [data?.pypi?.latest, electronVersion, currentVersion],
  );

  const handleUpgrade = useCallback(async () => {
    if (!electronApi?.upgradeFlowpad) return;
    setUpgradeError(null);
    setUpgrading(true);
    try {
      // Pre-flight: does the latest release run on THIS desktop? When it does not, the popup offers the
      // coordinated update instead of starting an upgrade the shell would refuse (or roll back) anyway.
      // fresh: a release published a minute ago must shape the popup (display rides the CDN; this does not).
      setUpgradeChecking(true);
      const info = await refreshUpdateInfo({ fresh: true });
      setUpgradeChecking(false);
      const engine = info?.engine ?? null;
      if (engine && engine.latestCompatible === false) {
        setModalError(null);
        setCompatInfo(buildCompatInfo(info, engine));
        return;
      }
      // Prepared in the background: the engine keeps serving while it downloads; the shell then asks
      // (update-ready) and the swap takes seconds. Older shells: the direct stop-and-upgrade.
      const r = electronApi.prepareEngine
        ? await electronApi.prepareEngine().then((p) => ({ success: p.started, ready: !!p.ready, desktopUpdatePending: p.desktopUpdatePending, error: p.started ? undefined : updateRefusalText(p.reason) }))
        : await electronApi.upgradeFlowpad();
      // `ready`: it was already staged in the background — the shell asks right away instead.
      if (r.success && electronApi.prepareEngine && !('ready' in r && r.ready)) setEnginePush({ state: 'preparing', version: engine?.latest ?? null });
      if (!r.success) {
        if (r.desktopUpdatePending) {
          // The shell holds engine changes while a desktop update is pending — same popup, same way out.
          setModalError(null);
          setCompatInfo(buildCompatInfo(info, engine));
        } else {
          setUpgradeError(r.error ?? t`Upgrade failed.`);
        }
      }
    } finally {
      setUpgradeChecking(false);
      setUpgrading(false);
    }
  }, [electronApi, refreshUpdateInfo, buildCompatInfo, updateRefusalText, t]);

  /** The panel started (or resumed) a desktop download: reflect the shell's answer in the row. */
  const notePanelStart = useCallback(
    (r: UpdateActionResult) => {
      setDesktopPush(
        r.ready ? { state: 'ready', version: r.version } : { state: 'downloading', percent: 0, version: r.version },
      );
      if (r.ready) return; // the shell asks (update-ready) once anything still staging is done
      // Started from the popup (the panel is closed under it): without this, Update Both closed the popup
      // and nothing visible happened — the progress lives in a panel nobody has open.
      if (!openRef.current) {
        notify.info({
          id: 'desktop-update-download',
          title: r.version ? t`Downloading FlowPad Desktop v${r.version}` : t`Downloading the desktop update`,
          message: r.engineVersion
            ? t`flow SDK v${r.engineVersion} is installed right after the restart. FlowPad asks before installing.`
            : t`FlowPad asks before installing it.`,
        });
      }
    },
    [t],
  );

  /** Start downloading the available desktop build (also the Retry after a failed download).
   *  A desktop update never leaves the engine behind: when a newer flow SDK exists too, the download
   *  goes through update:both, so the new desktop installs that version right after the restart. */
  const handleDesktopDownload = useCallback(async () => {
    if (!electronApi?.downloadDesktopUpdate) return;
    setDesktopActionError(null);
    setDesktopActionNote(null);
    const engine = updateInfo?.engine ?? null;
    // Product rule: a desktop update never leaves the engine behind. The shell SUBSTITUTES an
    // engine the target desktop accepts when the latest does not fit (or lets the desktop go alone
    // when none is newer than installed) — so there is no desktop-only branch here.
    const engineTarget = engine?.updateAvailable ? engine.latest : null;
    const r =
      engineTarget && electronApi.updateBoth
        ? await electronApi.updateBoth(engineTarget)
        : await electronApi.downloadDesktopUpdate();
    if (!r.started) {
      setDesktopActionError(updateRefusalText(r.reason));
      return;
    }
    if (engineTarget && r.engineVersion === null) {
      // The shell let the desktop go alone (no newer flow SDK fits the target build): not an error,
      // but silently dropping the engine is exactly what an earlier round was called out for.
      setDesktopActionNote(t`No newer flow SDK fits this desktop build — the desktop updates alone and the installed flow SDK stays.`);
    }
    notePanelStart(r);
  }, [electronApi, updateInfo, updateRefusalText, notePanelStart, t]);

  /** Install the downloaded desktop build now (the app restarts to apply it). */
  /** After a late install failure: FlowPad quits gracefully and starts again to apply the update. */
  const handleRestartApp = useCallback(async () => {
    if (!electronApi?.restartApp) return;
    await electronApi.restartApp();
  }, [electronApi]);

  /** Stop the download in progress (a stalled one never ends by itself); the row returns to Download. */
  const handleCancelDownload = useCallback(async () => {
    if (!electronApi?.cancelDesktopDownload) return;
    const r = await electronApi.cancelDesktopDownload();
    if (r.cancelled) {
      setDesktopPush(null);
      void refreshUpdateInfo();
    }
  }, [electronApi, refreshUpdateInfo]);

  const handleDesktopApply = useCallback(async () => {
    if (!electronApi?.applyDesktopUpdate) return;
    setDesktopActionError(null);
    const r = await electronApi.applyDesktopUpdate();
    // 'apply-failed': the shell already pushed the error row (with its Retry) — no second message.
    if (!r.started && r.reason !== 'apply-failed') setDesktopActionError(updateRefusalText(r.reason));
    // started → the shell pushes {state:'installing'} and restarts the app.
  }, [electronApi, updateRefusalText]);

  /** "Update now" next to a staged flow SDK: the swap (seconds, FlowPad stays open) — no second question. */
  const [engineApplyError, setEngineApplyError] = useState<string | null>(null);
  const handleEngineApply = useCallback(async () => {
    if (!electronApi?.applyEngineUpdate) return;
    setEngineApplyError(null);
    const r = await electronApi.applyEngineUpdate();
    // Success swaps the window to the loading screen and back: this page is replaced.
    if (r && !r.started) setEngineApplyError(r.error ? firstLine(r.error) : updateRefusalText(r.reason));
  }, [electronApi, updateRefusalText]);

  /** The ready dialog's "Update now": the engine swap (seconds) or the desktop install (a restart). */
  const handleReadyNow = useCallback(async () => {
    if (!readyAsk) return;
    setReadyBusy(true);
    setReadyError(null);
    try {
      if (readyAsk.kind === 'engine') {
        const r = await electronApi?.applyEngineUpdate?.();
        // Success swaps the window to the loading screen and back: this page is replaced.
        if (r && !r.started) setReadyError(r.error ? firstLine(r.error) : updateRefusalText(r.reason));
      } else {
        const r = await electronApi?.applyDesktopUpdate?.();
        if (r && !r.started && r.reason !== 'apply-failed') setReadyError(updateRefusalText(r.reason));
        if (r && !r.started && r.reason === 'apply-failed') setReadyAsk(null); // the row shows the failure and its way out
      }
    } finally {
      setReadyBusy(false);
    }
  }, [electronApi, readyAsk, updateRefusalText]);

  /** The popup's fallback: no suitable desktop build yet, but a newer flow SDK that runs on THIS
   *  desktop exists — install it through the normal shell upgrade, which resolves exactly that
   *  release (the native dialog path offers the same thing). */
  const handleUpgradeCompatible = useCallback(async () => {
    if (!electronApi?.upgradeFlowpad) return;
    const version = compatInfo?.newestCompatible ?? undefined;
    setCompatInfo(null);
    setUpgradeError(null);
    setUpgrading(true);
    try {
      // The pin lets the shell bypass its desktop-first hold for exactly this release — its floor is
      // met by the RUNNING desktop, which is the whole point of the button. Prepared in the background
      // like every engine update.
      if (electronApi.prepareEngine) {
        const p = await electronApi.prepareEngine(version ? { version } : undefined);
        if (p.started) setEnginePush({ state: 'preparing', version: version ?? null });
        else setUpgradeError(updateRefusalText(p.reason));
      } else {
        const r = await electronApi.upgradeFlowpad(version ? { version } : undefined);
        if (!r.success) setUpgradeError(r.error ?? t`Upgrade failed.`);
      }
    } finally {
      setUpgrading(false);
    }
  }, [electronApi, compatInfo, updateRefusalText, t]);

  /** "Update directly" after a background download that keeps failing: the old stop-install-start path. */
  const handleEngineDirect = useCallback(async () => {
    if (!electronApi?.upgradeFlowpad) return;
    const version = (enginePush?.version ?? updateInfo?.engineUpdate?.version) || undefined;
    setUpgradeError(null);
    const r = await electronApi.upgradeFlowpad({ ...(version ? { version } : {}), direct: true });
    if (!r.success) setUpgradeError(r.error ?? t`Upgrade failed.`);
  }, [electronApi, enginePush, updateInfo, t]);

  /** "Try again" after a failed background download of the flow SDK. */
  const handleEngineRetry = useCallback(async () => {
    if (!electronApi?.prepareEngine) return;
    const version = (enginePush?.version ?? updateInfo?.engineUpdate?.version) || undefined;
    const p = await electronApi.prepareEngine(version ? { version } : undefined);
    if (p.started) setEnginePush({ state: 'preparing', version: version ?? null });
    else setUpgradeError(updateRefusalText(p.reason));
  }, [electronApi, enginePush, updateInfo, updateRefusalText]);

  const handleUpdateBoth = useCallback(async () => {
    if (!electronApi?.updateBoth || !compatInfo?.engineTarget) return;
    setModalBusy(true);
    setModalError(null);
    try {
      const r = await electronApi.updateBoth(compatInfo.engineTarget);
      if (!r.started) {
        setModalError(updateRefusalText(r.reason));
        return;
      }
      setCompatInfo(null);
      // The shell may ride with a different flow SDK than asked (the newest the target desktop accepts),
      // or none: the row says so — silently changing what the user agreed to is not an option.
      if (r.engineVersion === null) {
        setDesktopActionNote(t`No newer flow SDK fits this desktop build — the desktop updates alone and the installed flow SDK stays.`);
      } else if (r.engineVersion && r.engineVersion !== compatInfo.engineTarget) {
        setDesktopActionNote(t`flow SDK v${r.engineVersion} will be installed after the restart — the newest that works with this desktop build.`);
      } else {
        setDesktopActionNote(null);
      }
      notePanelStart(r);
    } finally {
      setModalBusy(false);
    }
  }, [electronApi, compatInfo, updateRefusalText, notePanelStart, t]);

  // Wait for the backend to go down and come back healthy, then reload so the
  // (possibly different-version) UI is reloaded fresh. The python monitor restart
  // can take a little while, so poll generously before giving up.
  const waitForRestartAndReload = useCallback(async () => {
    const deadline = Date.now() + 90_000;
    // Give the old server a moment to actually exit first.
    await new Promise((r) => setTimeout(r, 3000));
    while (Date.now() < deadline) {
      try {
        await apiClient.get('/health/status', { headers: { 'Cache-Control': 'no-store' } });
        window.location.reload();
        return;
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
        const json = await apiClient.post<InstallVersionResponse>('/api/v1/version/install', { version });
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

  // What the Desktop section's action row shows: the shell's status snapshot, overridden by live
  // progress pushes. Null outside the desktop app (or on a shell without the update IPC).
  // The live push wins over the snapshot (the snapshot is read only when the popover opens).
  const engineView: EngineUpdateState | null = enginePush ?? updateInfo?.engineUpdate ?? null;

  const desktopView = useMemo(() => {
    if (!electronApi?.getUpdateInfo) return null;
    const snap = updateInfo?.desktop ?? null;
    const pushState = desktopPush ? desktopPush.state : null;
    const flow = pushState ?? (snap && snap.downloadState !== 'idle' ? snap.downloadState : null);
    return {
      // 'downloading' | 'ready' | 'installing' | 'error' while an update moves;
      // otherwise the feed verdict: 'available' | 'current' | 'unknown' | 'unsupported'.
      phase: flow ?? snap?.state ?? null, // null until the shell's first answer: render nothing yet
      percent: desktopPush?.percent ?? null,
      version: desktopPush?.version ?? snap?.available ?? null,
      error: desktopPush?.error ?? null,
      applyFailed: desktopPush?.state === 'error' && desktopPush.apply === true,
      // Only a restart can apply it now (a late install failure): Retry / Update Now would do nothing.
      restartRequired: Boolean(snap?.restartRequired || (desktopPush?.state === 'error' && desktopPush.restart)),
    };
  }, [electronApi, updateInfo, desktopPush]);
  // Downloaded and checked, and not taken yet ("Later"): installable from the badge row, any time.
  const engineReady = !!(engineView && engineView.state === 'ready' && !engineView.coordinated && electronApi?.applyEngineUpdate);
  const desktopReady = !!(desktopView && desktopView.phase === 'ready' && !desktopView.restartRequired);

  const { pypiCurrentPublished, pypiLatestPublished, electronCurrentRelease, githubUpdateAvailable } = useMemo(() => {
    // Generically named on the wire, but GitHub Releases carry DESKTOP tags
    // only — never a flow SDK version. Naming it here so the next reader is
    // not tempted to resolve an SDK version out of it, which is exactly how
    // both PyPI rows ended up with a blank date.
    const githubReleases = data?.releases ?? [];
    return {
      pypiCurrentPublished: findPypiRelease(pypi?.releases, currentVersion),
      pypiLatestPublished: findPypiRelease(pypi?.releases, pypi?.latest),
      electronCurrentRelease: findReleaseByTag(githubReleases, electronVersion),
      githubUpdateAvailable: Boolean(
        electronVersion && githubLatest && electronVersion.replace(/^v/i, '') !== githubLatest.tag,
      ),
    };
  }, [data?.releases, pypi?.releases, currentVersion, pypi?.latest, electronVersion, githubLatest]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <VersionChip
          ref={targetRef}
          version={currentVersion}
          updateAvailable={Boolean(pypi?.update_available || githubUpdateAvailable || engineReady || desktopReady)}
          data-testid="version-popover-trigger"
        />
      </PopoverTrigger>
      <PopoverContent ref={sourceRef} side="top" align="end" className="w-96 p-3">
        <div className="space-y-3">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">
                <Trans>Flowpad</Trans>
              </h3>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {/* What this UI runs on, from the backend — the same label as the nav bar's chip.
                    `mode` only says whether this is the Electron shell. */}
                {context?.runtimeKind ? <RuntimeLabel kind={context.runtimeKind} /> : mode}
              </span>
              {isDev && instanceName && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {instanceName}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void fetchData(true)}
              disabled={loading}
              className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              title={t`Check again`}
              aria-label={t`Check again`}
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </button>
          </div>

          {/* Dev-only: render the local desktop server's hub page for testing/debugging. */}
          {isDev && (
            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-2 py-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">
                <Trans>Page</Trans>
              </span>
              <div
                className="flex items-center gap-0.5 rounded-md bg-muted p-0.5"
                role="group"
                aria-label={t`App page`}
              >
                {(['desk', 'hub'] as const).map((page) => {
                  const active = (appPage ?? 'desk') === page;
                  return (
                    <button
                      key={page}
                      type="button"
                      data-testid={`app-page-${page}`}
                      aria-pressed={active}
                      disabled={switchingPage}
                      onClick={() => void selectAppPage(page)}
                      className={`rounded-sm px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50 ${
                        active
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {page === 'desk' ? <Trans>Desktop</Trans> : <Trans>Hub</Trans>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              <Trans>Couldn't check for updates: {error}</Trans>
            </div>
          )}

          {updateInfo?.pairWarning && (
            <div
              className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive"
              data-testid="incompatible-pair-warning"
            >
              {updateInfo.pairWarning}
            </div>
          )}

          {restarting && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              <span>
                <Trans>Installing and restarting Flowpad… this can take up to a minute.</Trans>
              </span>
            </div>
          )}

          {/* Python / PyPI section */}
          <section className="space-y-1.5">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Trans>Python (flow SDK)</Trans>
              </h4>
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
                    <span>
                      <Trans>Change</Trans>
                    </span>
                  </button>
                )}
              </div>
            </div>
            <VersionRow
              label={t`Installed`}
              version={currentVersion}
              date={formatDateWithAge(pypiCurrentPublished?.published_at)}
            />
            <VersionRow
              label={t`Latest on PyPI`}
              version={engineReady ? (engineView?.version ?? pypi?.latest ?? null) : (pypi?.latest ?? null)}
              date={formatDateWithAge(pypiLatestPublished?.published_at)}
              badge={engineReady ? t`Ready to install` : pypi?.update_available ? t`Update available` : null}
              muted={!engineReady && !pypi?.update_available}
              action={
                engineReady
                  ? {
                      label: t`Update now`,
                      title: engineView?.version ? t`Switch to flow SDK v${engineView.version} — FlowPad stays open` : undefined,
                      onClick: () => void runDesktopAction(handleEngineApply),
                      disabled: desktopActionBusy,
                      testId: 'engine-restart-now-button',
                    }
                  : null
              }
            />
            {data?.installed_at && <TimestampRow label={t`Installed on`} timestamp={data.installed_at} />}
            {/* No release notes here: PyPI carries no notes body (``PypiRelease``
                is version/date/yanked only), and GitHub Releases are desktop
                tags, so an SDK version never resolves there. The rows that used
                to try rendered nothing, every time. */}
            {engineView && engineView.state !== 'idle' && !engineView.coordinated && (engineView.state !== 'ready' || engineApplyError) && (
              <div className="space-y-1.5 pt-1" data-testid="engine-update-row">
                {engineView.state === 'preparing' && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                      <span>
                        {engineView.version
                          ? t`Downloading flow SDK v${engineView.version} in the background — FlowPad keeps working.`
                          : t`Downloading the flow SDK update in the background — FlowPad keeps working.`}
                      </span>
                    </div>
                    {electronApi?.cancelEngineUpdate && (
                      <button
                        type="button"
                        onClick={() => void electronApi.cancelEngineUpdate?.().then((r) => { if (r.cancelled) setEnginePush({ state: 'idle' }); })}
                        data-testid="engine-update-cancel-button"
                        className="rounded-sm border px-2 py-0.5 text-[10px] font-medium transition-colors hover:bg-accent"
                      >
                        <Trans>Cancel download</Trans>
                      </button>
                    )}
                  </div>
                )}
                {engineView.state === 'ready' && engineApplyError && (
                  <p className="text-[10px] text-destructive" data-testid="engine-apply-error">
                    {engineApplyError}
                  </p>
                )}
                {engineView.state === 'error' && (
                  <div className="space-y-1">
                    <p className="text-[10px] text-destructive">{engineView.error ?? t`The flow SDK update could not be downloaded.`}</p>
                    <button
                      type="button"
                      onClick={() => void handleEngineRetry()}
                      data-testid="engine-update-retry-button"
                      className="flex w-full items-center justify-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
                    >
                      <Trans>Try again</Trans>
                    </button>
                    {/* The background download keeps failing (a blocked staging folder, antivirus): the
                        old way still works — the engine stops, updates, and starts again. */}
                    <button
                      type="button"
                      onClick={() => void handleEngineDirect()}
                      data-testid="engine-upgrade-direct-button"
                      className="flex w-full items-center justify-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
                    >
                      <Trans>Update directly (FlowPad pauses while it installs)</Trans>
                    </button>
                  </div>
                )}
              </div>
            )}
            {pypi?.update_available && pypi.latest && !(engineView && engineView.state !== 'idle' && !engineView.coordinated) && (
              <div className="pt-1">
                {/* The desktop app upgrades through its own updater; a browser tab asks the backend
                    to install the release and restart (the same install the version picker uses). */}
                <button
                  type="button"
                  onClick={() =>
                    void (electronApi?.upgradeFlowpad ? handleUpgrade() : handleInstallVersion(pypi.latest!))
                  }
                  disabled={upgrading || restarting}
                  data-testid="version-upgrade-button"
                  className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                >
                  {upgrading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {upgrading ? (upgradeChecking ? t`Checking…` : t`Upgrading…`) : t`Upgrade to v${(mode === 'Desktop' && updateInfo?.engine?.latest) || pypi.latest}`}
                </button>
                {upgradeError && (
                  <div
                    className="mt-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive"
                    data-testid="upgrade-error"
                  >
                    {upgradeError}
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
              <span>
                <Trans>View on PyPI</Trans>
              </span>
            </button>

            {picking && (
              <div className="space-y-1.5 pt-1">
                <p className="text-[10px] text-muted-foreground">
                  <Trans>Select a version to install:</Trans>
                </p>
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
                          className={`flex w-full items-center justify-between gap-2 px-2 py-1 text-start text-[11px] transition-colors disabled:cursor-default ${
                            isPending ? 'bg-accent' : 'hover:bg-accent'
                          } ${isCurrent || r.yanked ? 'opacity-60' : ''}`}
                        >
                          <span className="font-mono">v{r.version}</span>
                          <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            {formatDateWithAge(r.published_at)}
                            {isCurrent && (
                              <span className="rounded-full bg-muted px-1.5 py-0.5 font-medium">
                                <Trans>current</Trans>
                              </span>
                            )}
                            {r.yanked && (
                              <span className="rounded-full bg-muted px-1.5 py-0.5 font-medium">
                                <Trans>yanked</Trans>
                              </span>
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
                                <CopyableCommand command={`uv tool install flowpad==${r.version}`} />
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
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Trans>Desktop version</Trans>
              </h4>
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
              version={desktopReady ? (desktopView?.version ?? githubLatest?.tag ?? null) : (githubLatest?.tag ?? null)}
              date={formatDateWithAge(githubLatest?.published_at)}
              badge={desktopReady ? t`Ready to install` : githubUpdateAvailable ? t`Update available` : null}
              muted={!desktopReady && !githubUpdateAvailable}
              action={
                desktopReady
                  ? {
                      label: t`Update now`,
                      title: desktopView?.version ? t`Install FlowPad Desktop v${desktopView.version} — FlowPad restarts` : undefined,
                      onClick: () => void runDesktopAction(handleDesktopApply),
                      disabled: desktopActionBusy,
                      testId: 'desktop-update-now-button',
                    }
                  : null
              }
            />
            {electronCurrentRelease && electronCurrentRelease.tag !== githubLatest?.tag && (
              <ReleaseNotes title={`Notes for v${electronVersion}`} release={electronCurrentRelease} />
            )}
            {githubLatest && <ReleaseNotes title={`Notes for v${githubLatest.tag}`} release={githubLatest} />}
            {/* Panel-driven desktop update (FLOWPAD-2310): Download when a build is available, live
                progress while it downloads, and Update Now once it is ready — including an update
                downloaded in the background earlier and postponed with "Later". */}
            {desktopView && (
              <div className="space-y-1.5 pt-1">
                {desktopView.phase === 'available' && (
                  <button
                    type="button"
                    onClick={() => void runDesktopAction(handleDesktopDownload)}
                    disabled={desktopActionBusy}
                    data-testid="desktop-download-button"
                    className="flex w-full items-center justify-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {desktopView.version ? t`Download v${desktopView.version}` : t`Download the desktop update`}
                  </button>
                )}
                {desktopView.phase === 'downloading' && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>
                        {desktopView.version
                          ? t`Downloading FlowPad Desktop v${desktopView.version}…`
                          : t`Downloading the desktop update…`}
                      </span>
                      {desktopView.percent != null && <span>{Math.round(desktopView.percent)}%</span>}
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" data-testid="desktop-download-progress">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${Math.min(100, Math.max(2, Math.round(desktopView.percent ?? 0)))}%` }}
                      />
                    </div>
                    {electronApi?.cancelDesktopDownload && (
                      <button
                        type="button"
                        onClick={() => void runDesktopAction(handleCancelDownload)}
                        disabled={desktopActionBusy}
                        data-testid="desktop-download-cancel-button"
                        className="rounded-sm border px-2 py-0.5 text-[10px] font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Trans>Cancel download</Trans>
                      </button>
                    )}
                  </div>
                )}
                {desktopView.restartRequired && desktopView.phase !== 'installing' && (
                  <div className="space-y-1">
                    {desktopView.error && <p className="text-[10px] text-destructive">{desktopView.error}</p>}
                    <p className="text-[10px] text-muted-foreground">
                      <Trans>
                        The update could not be installed from this session. Restart FlowPad to install it — FlowPad
                        quits and starts again.
                      </Trans>
                    </p>
                    <button
                      type="button"
                      onClick={() => void runDesktopAction(handleRestartApp)}
                      disabled={desktopActionBusy}
                      data-testid="desktop-restart-app-button"
                      className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Trans>Restart FlowPad</Trans>
                    </button>
                  </div>
                )}
                {desktopView.phase === 'installing' && (
                  <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    <span>
                      <Trans>Restarting to install the update…</Trans>
                    </span>
                  </div>
                )}
                {desktopView.phase === 'error' && !desktopView.restartRequired && (
                  <div className="space-y-1">
                    <p className="text-[10px] text-destructive">
                      {desktopView.error ?? t`The desktop update failed.`}
                    </p>
                    <button
                      type="button"
                      onClick={() => void runDesktopAction(desktopView.applyFailed ? handleDesktopApply : handleDesktopDownload)}
                      disabled={desktopActionBusy}
                      data-testid="desktop-update-retry-button"
                      className="flex w-full items-center justify-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {desktopView.applyFailed ? <Trans>Retry the update</Trans> : <Trans>Retry the download</Trans>}
                    </button>
                  </div>
                )}
                {desktopView.phase === 'current' && (
                  <p className="text-[10px] text-muted-foreground" data-testid="desktop-up-to-date">
                    <Trans>Up to date. FlowPad checks for updates automatically.</Trans>
                  </p>
                )}
                {desktopView.phase === 'unknown' && (
                  <div
                    className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground"
                    data-testid="desktop-check-failed"
                  >
                    <span>
                      <Trans>Could not check for desktop updates.</Trans>
                    </span>
                    <button
                      type="button"
                      onClick={() => void refreshUpdateInfo()}
                      className="rounded-sm border px-2 py-0.5 font-medium transition-colors hover:bg-accent"
                    >
                      <Trans>Check again</Trans>
                    </button>
                  </div>
                )}
                {desktopActionError && <p className="text-[10px] text-destructive">{desktopActionError}</p>}
                {desktopActionNote && (
                  <p className="text-[10px] text-muted-foreground" data-testid="desktop-action-note">
                    {desktopActionNote}
                  </p>
                )}
              </div>
            )}
            {mode === 'Desktop' && !desktopView && !githubUpdateAvailable && !data?.github_error && (
              <p className="text-[10px] text-muted-foreground">
                <Trans>FlowPad checks for updates automatically.</Trans>
              </p>
            )}
            {githubLatest?.html_url && (
              <button
                type="button"
                onClick={() => void handleOpenExternal(githubLatest.html_url!)}
                className="flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ExternalLink className="h-3 w-3" />
                <span>
                  <Trans>View on GitHub</Trans>
                </span>
              </button>
            )}
          </section>

          {data?.hub && (
            <>
              <div className="border-t" />
              <section className="space-y-1.5">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Trans>Cloud hub</Trans>
                </h4>
                <VersionRow label={t`Hub`} version={data.hub.version} />
                <TimestampRow label={t`Deployed`} timestamp={data.hub.deployed_at} />
                <TimestampRow label={t`Generated`} timestamp={data.hub.generated_at} />
              </section>
            </>
          )}

          <div className="border-t" />
          <section className="space-y-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Trans>Connection Info</Trans>
            </h4>
            <CopyableUrlField label={t`URL`} value={window.location.href} />
            <CopyableUrlField label={t`Connection ID`} value={connectionManager.id} />
          </section>

          {/* Toolbar */}
          <div className="-mx-3 -mb-3 mt-1 flex gap-2 border-t px-3 pb-1 pt-2.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() => {
                setOpen(false);
                openLlmSources(navigation);
              }}
              title={t`Harness sign-in & status`}
              data-testid="version-harness-status"
            >
              <KeyRound />
              <span>
                <Trans>Harness status</Trans>
              </span>
            </Button>
            <Button
              type="button"
              size="sm"
              className="flex-1"
              onClick={() => {
                setOpen(false);
                setDiagnoseOpen(true);
              }}
              title={t`Diagnose a Flowpad issue`}
            >
              <Stethoscope />
              <span>
                <Trans>Diagnose</Trans>
              </span>
            </Button>
          </div>
        </div>
      </PopoverContent>
      <UpdateReadyModal
        info={readyAsk}
        busy={readyBusy}
        error={readyError}
        onRestartNow={() => void handleReadyNow()}
        onLater={() => {
          setReadyAsk(null);
          setReadyError(null);
        }}
      />
      <DesktopUpdateModal
        open={!!compatInfo}
        info={compatInfo}
        busy={modalBusy}
        error={modalError}
        onUpdateBoth={() => void handleUpdateBoth()}
        onUpgradeCompatible={() => void handleUpgradeCompatible()}
        onClose={() => {
          setCompatInfo(null);
          setModalError(null);
        }}
      />
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
