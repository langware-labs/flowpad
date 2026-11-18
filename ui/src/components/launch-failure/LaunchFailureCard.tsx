import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { AgenticProcess, FlowData, LaunchFailureValue } from '@sdk';
import { openLlmSources } from '@src/components/llm-sources/llm-sources-pointer';
import { AskInstallOneOfDialog } from '@src/components/terminal/openers/AskInstallOneOfDialog';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { HARNESS_CAPABILITY_BY_WORKER, normalizeWorkerType } from '@src/components/workers/worker-types';
import { workerLabel } from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import { errorMessage } from '@src/lib/error-message';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { createOverlayStore } from '@src/store/create-overlay-store';
import { Info, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export type LaunchFailure = Required<Pick<LaunchFailureValue, 'code' | 'fix'>> & LaunchFailureValue;
// One ICU select per line of the card, keyed on the code (button: on the fix). Empty line 2 = first evidence line.
const LINE1 = msg({
  message:
    "{code, select, folder_not_trusted {Trust folder {name}?} first_run_setup {{h} needs a one-time setup} bypass_warning {{h} asks to confirm full access} signed_out {{h} isn't connected to an account} key_rejected {{provider} key ****{key_hint} was rejected} budget_not_ready {Getting your Flowpad budget ready…} not_installed {{h} isn't installed on this computer} cli_crashed {{h} crashed on start} cli_outdated {{h} is too old for this model} pinned_source_unavailable {This project requires {source_name}} other {{h} couldn't start}}",
});
const LINE2 = msg({
  message:
    "{code, select, folder_not_trusted {{folder} — {h} asks once per folder} first_run_setup {Theme and sign-in screens are waiting} bypass_warning {Flowpad runs it without per-step prompts} signed_out {No sign-in or key} budget_not_ready {{h} starts by itself when it's ready} not_installed {Install takes about a minute} cli_outdated {Update it to the newest version} pinned_source_unavailable {It isn't set up on this computer} other {}}",
});
const BUTTON = msg({
  message:
    '{fix, select, trust_folder {Trust} finish_setup {Finish setup} accept_bypass {Allow} connect {Connect} replace_key {Replace key} install {Install} reinstall {Reinstall} ask_owner {Set up} other {Try again}}',
});
// Old servers send only a sentence: [code, fix, pattern].
const LEGACY: [string, string, RegExp][] = [
  ['signed_out', 'connect', /no usable llm/i],
  ['not_installed', 'install', /is not installed/i],
  ['cli_crashed', 'reinstall', /exited .*after launch/i],
  ['cli_outdated', 'reinstall', /requires a newer version/i],
];
const make = (v: LaunchFailureValue): LaunchFailure => ({
  ...v,
  code: v.code === 'not_authenticated' ? 'signed_out' : v.code,
  fix: v.fix ?? 'retry',
});

type Refused = { response?: { data?: { data?: { launch_failure?: LaunchFailureValue } } } };
/** The typed failure behind a refused call or on a process, else a legacy sentence; null if none. */
export function readLaunchFailure(source: unknown): LaunchFailure | null {
  if (!source || typeof source !== 'object') return null;
  const s = source as Refused & Partial<AgenticProcess>;
  const typed = s.response?.data?.data?.launch_failure ?? s.launch_failure;
  if (typed?.code) return make(typed);
  const text = s.start_failure || ('launch_failure' in s ? '' : errorMessage(source, ''));
  const [code, fix] = LEGACY.find(([, , re]) => re.test(text)) ?? (s.start_failure ? ['unknown'] : []);
  return code ? make({ code, fix, detail: text }) : null;
}

/** THE launch-failure card: two lines, one button, the rest in the (i) tip. */
type Props = { failure: LaunchFailure; retry: () => Promise<unknown>; process?: AgenticProcess | null };
export function LaunchFailureCard({ failure: f0, retry, process }: Props) {
  const { navigation } = useDockNavigation();
  const [busy, setBusy] = useState(false);
  const [handedOff, setHandedOff] = useState(false);
  const [install, setInstall] = useState<string[] | null>(null);
  const [expired, setExpired] = useState(false);
  const waiting = f0.code === 'budget_not_ready' && !expired;
  const f = expired ? { ...f0, code: 'signed_out', fix: 'connect' } : f0;
  const worker = normalizeWorkerType(f.worker_type ?? process?.worker_type ?? undefined);
  const retryRef = useRef(retry);
  retryRef.current = retry;
  useEffect(() => {
    if (!waiting) return;
    // Back off 5s, then 10s more; then show the signed-out card.
    const ids = [5_000, 15_000].map((t) => setTimeout(() => void retryRef.current().catch(() => undefined), t));
    ids.push(setTimeout(() => setExpired(true), BUDGET_WAIT_MS));
    return () => ids.forEach(clearTimeout);
  }, [waiting]);
  const fix = handedOff ? 'retry' : f.fix;
  // A blocked prompt is fixed server-side (headless answers relaunched:false: re-send). UI fixes hand off, then retry.
  // LLM sources, not sign-in: an unfunded harness is often a preference a sign-in can't clear.
  const run = async () => {
    if (fix === 'retry' || (f.phase === 'blocked' && !process)) return retry();
    if (f.phase === 'blocked') return (await process!.resolveLaunchFailure(fix))?.relaunched === false && retry();
    if (fix.endsWith('install')) setInstall([HARNESS_CAPABILITY_BY_WORKER[worker]]);
    else openLlmSources(navigation, worker);
    setHandedOff(true);
  };
  const onClick = () => {
    setBusy(true);
    if (fix === 'retry') setHandedOff(false);
    void run()
      .catch(console.error)
      .finally(() => setBusy(false));
  };
  const folder = f.facts?.folder ?? '';
  const name = folder.split(/[\\/]/).filter(Boolean).pop();
  const values = { code: f.code, fix, h: workerLabel(worker), folder, name, provider: 'API', ...f.facts };
  const line2 = i18n._(LINE2.id, values, { message: LINE2.message }) || (f.evidence || f.detail || '').trim().split('\n')[0];
  const tip = [f.detail, f.evidence].filter(Boolean).join('\n\n');
  return (
    <div
      className="flex items-center gap-3 rounded-lg border px-3 py-2"
      data-testid="launch-failure-card"
      data-code={f.code}
    >
      {(waiting || busy) && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      <div className="min-w-0 flex-1 truncate">
        <div className="truncate text-sm font-medium" data-testid="launch-failure-title">
          {i18n._(LINE1.id, values, { message: LINE1.message })}
        </div>
        <div className="truncate text-xs text-muted-foreground">{line2}</div>
      </div>
      {tip && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger aria-label={tip} data-testid="launch-failure-info">
              <Info className="size-3.5 shrink-0 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent className="max-w-sm whitespace-pre-wrap break-words text-xs">{tip}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {!waiting && (
        <Button size="sm" onClick={onClick} disabled={busy} data-testid="launch-failure-fix" data-fix={fix}>
          {i18n._(BUTTON.id, values, { message: BUTTON.message })}
        </Button>
      )}
      <AskInstallOneOfDialog kinds={install} onClose={() => setInstall(null)} />
    </div>
  );
}
export const BUDGET_WAIT_MS = 30_000;

/** The card for an existing process (its failure, else an exit-error frame); headless retry re-sends the prompt. */
type ProcessProps = {
  process?: AgenticProcess | null;
  frame?: FlowData;
  retry?: () => Promise<unknown>;
  resendPrompt?: string | null;
};
export function ProcessLaunchFailureCard({ process, frame, retry, resendPrompt }: ProcessProps) {
  const latched = frame ? { start_failure: String(frame.content || 'exit-error') } : null;
  const failure = process && (readLaunchFailure(process) ?? readLaunchFailure(latched));
  if (!process || !failure) return null;
  const again = async () => {
    if (process.pty_mode || !resendPrompt) return process.start({ visible: !!process.pty_mode, retry: true });
    if (process.start_failure || process.launch_failure) await process.start({ retry: true }).catch(() => undefined);
    return process.prompt(resendPrompt);
  };
  return <LaunchFailureCard failure={failure} retry={retry ?? again} process={process} />;
}

const store = createOverlayStore<{ failure: LaunchFailure; retry: () => Promise<unknown> }>();
export const useLaunchFailureStore = store.useStore;

/** THE catch target of every launch entry point; false when `error` is no launch failure. */
export function handleLaunchFailure(error: unknown, retry: () => Promise<unknown>, worker?: string | null): boolean {
  const failure = readLaunchFailure(error);
  if (failure) store.open({ failure: { worker_type: worker, ...failure }, retry });
  return !!failure;
}

/** A refused create has no pane yet: its card floats until fixed or dismissed. */
export function LaunchFailureRoot() {
  const { payload } = useLaunchFailureStore();
  if (!payload) return null;
  const retry = () => payload.retry().then(() => store.useStore.getState().payload === payload && store.close());
  return (
    <div
      className="fixed bottom-6 left-1/2 z-50 flex w-[32rem] -translate-x-1/2 bg-background"
      data-testid="launch-failure-floating"
    >
      <LaunchFailureCard key={payload.failure.code} failure={payload.failure} retry={retry} />
      <button type="button" className="px-2" onClick={store.close} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
