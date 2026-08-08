import { APIEntity } from '../APIEntity';
import { AgenticProcess } from './agentic-process';

export type WizardStatus = 'done' | 'cancel' | 'error';

export interface WizardProcessResult<T = unknown> {
  status: WizardStatus;
  data: T | null;
  errorStr?: string | null;
}

export interface WizardData {
  title?: string;
  prompt?: string;
  payload?: Record<string, unknown>;
  targetTypeId?: string;
  /** Shape of the `data` this wizard is expected to close with, rendered into
   *  the close command the agent is shown. Without it the example carries no
   *  `data` at all — never an empty `{}`, which agents run verbatim and so
   *  report nothing back to the caller. Values are placeholders describing the
   *  field (e.g. `{ readyForDone: '<true|false>' }`), not real results. */
  resultShape?: Record<string, unknown>;
  /** Model for the run: a `WorkerModelTier` (`sm`/`md`/`lg`) or a concrete name.
   *  Omitted means the worker's default. A narrow, mechanical wizard should ask
   *  for `sm` — it is markedly cheaper and faster, and the tier resolves per
   *  worker so it still means "the small model" on codex/copilot. */
  model?: string;
}

export interface WizardLaunchRequest {
  wizardName: string;
  wizardData?: WizardData;
}

export interface WizardLaunchContext extends WizardLaunchRequest {
  wizardId: string;
}

export type WizardLauncher = <T = unknown>(
  request: WizardLaunchRequest,
) => Promise<WizardProcessResult<T>>;

let launcher: WizardLauncher | null = null;

export function setWizardLauncher(next: WizardLauncher | null): () => void {
  const previous = launcher;
  launcher = next;
  return () => {
    launcher = previous;
  };
}

export async function launchWizard<T = unknown>(
  wizardName: string,
  wizardData?: WizardData,
): Promise<WizardProcessResult<T>> {
  if (!launcher) {
    throw new Error('No wizard launcher is registered');
  }
  return launcher<T>({ wizardName, wizardData });
}

export function normalizeWizardResult<T = unknown>(
  raw: unknown,
): WizardProcessResult<T> {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const status = obj.status === 'done' || obj.status === 'cancel' || obj.status === 'error'
    ? obj.status
    : 'error';
  return {
    status,
    data: (obj.data ?? null) as T | null,
    errorStr: typeof obj.errorStr === 'string' ? obj.errorStr : null,
  };
}

export function awaitWizardResult<T = unknown>(
  process: Pick<AgenticProcess, 'on'>,
  options?: { timeoutMs?: number },
): Promise<WizardProcessResult<T>> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: () => void = () => {};
    const finish = (result: WizardProcessResult<T>) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };
    unsubscribe = process.on('entity_event', (event: string, payload: Record<string, unknown>) => {
      if (event !== 'wizard.closed') return;
      finish(normalizeWizardResult<T>(payload));
    });
    if (options?.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        finish({ status: 'error', data: null, errorStr: 'Wizard timed out' });
      }, options.timeoutMs);
    }
  });
}

export async function completeWizard<T = unknown>(
  process: AgenticProcess,
  result: WizardProcessResult<T>,
): Promise<unknown> {
  return APIEntity.entityEvent(process.typeId, 'wizard.close', {
    ...result,
    wizardId: process.id,
  } as Record<string, unknown>);
}

export function buildWizardPrompt(
  processId: string,
  request: WizardLaunchRequest,
  opts?: { headless?: boolean },
): string {
  const prompt = request.wizardData?.prompt?.trim() || `Help me complete the ${request.wizardName} setup.`;
  const payload = request.wizardData?.payload
    ? `\n\nWizard data:\n${JSON.stringify(request.wizardData.payload, null, 2)}`
    : '';
  // Tell the agent how it is being presented so it can decide whether to close
  // itself. Headless (WizardButton) has no UI to close it, so the agent MUST
  // close; an interactive popup lets the user close it, so a wait-for-user
  // agent may defer. Agents that always self-close ignore this line.
  const presentation = opts?.headless
    ? `\n\nPresentation: headless — no wizard UI is shown, so you MUST close the wizard yourself when done (do not wait for a user to close it).`
    : `\n\nPresentation: interactive popup — a wizard UI is shown; if your instructions say to let the user close it, wait for them instead of closing yourself.`;
  // The close command is an EXAMPLE, but it is also runnable — so it must never
  // be runnable-as-is with an empty result. With a resultShape we show the
  // caller's expected fields as placeholders (the agent has to replace them);
  // without one we omit `data` entirely rather than emit `"data":{}`, which
  // agents paste verbatim and thereby report nothing back.
  const shape = request.wizardData?.resultShape;
  const closeExample = shape
    ? `flow wizard ${processId} close '${JSON.stringify({ status: 'done', data: shape })}'
Replace every <…> placeholder above with your actual result — do not close with an empty or unedited \`data\`.
Write any path with forward slashes (C:/Users/… not C:\\Users\\…) — a backslash is a JSON escape and corrupts the value.`
    : `flow wizard ${processId} close '{"status":"done"}'
If your instructions define a result payload, add it as \`"data": {…}\`.`;
  return `${prompt}${payload}

When the wizard is complete, close it by running:
${closeExample}

If the user cancels or the setup cannot complete, run the same command with status "cancel" or "error".${presentation}`;
}
