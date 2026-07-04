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
): string {
  const prompt = request.wizardData?.prompt?.trim() || `Help me complete the ${request.wizardName} setup.`;
  const payload = request.wizardData?.payload
    ? `\n\nWizard data:\n${JSON.stringify(request.wizardData.payload, null, 2)}`
    : '';
  return `${prompt}${payload}

When the wizard is complete, close it by running:
flow wizard ${processId} close '{"status":"done","data":{}}'

If the user cancels or the setup cannot complete, run the same command with status "cancel" or "error".`;
}
