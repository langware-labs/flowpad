import type { AgenticProcess, WizardLaunchRequest } from '@sdk';

export interface WizardModalAttachment {
  process: AgenticProcess;
  target: string;
  request: WizardLaunchRequest;
}

type AttachFn = (attachment: WizardModalAttachment) => void;

let attachFn: AttachFn | null = null;

/**
 * `WizardHost` registers this so an already-running headless wizard (started by
 * a `WizardButton`) can be surfaced in the modal viewer on demand — the
 * double-click-while-running path. Returns an unregister fn.
 */
export function setWizardModalAttach(fn: AttachFn | null): () => void {
  attachFn = fn;
  return () => {
    if (attachFn === fn) attachFn = null;
  };
}

/** Surface a running wizard process in the modal. Returns false if no host is mounted. */
export function attachWizardModal(attachment: WizardModalAttachment): boolean {
  if (!attachFn) return false;
  attachFn(attachment);
  return true;
}
