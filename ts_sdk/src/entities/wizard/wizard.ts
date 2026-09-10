import { APIEntity, registerEntity } from '../../APIEntity';
import { IEntity, EntityMerge } from '../../IEntity';

/** One value a parked run is blocked on, with enough to draw a field. */
export interface WizardAwaiting {
  name: string;
  /** The declared shape in authoring form — `"string"`, an object, a one-element list. */
  shape?: unknown;
  label?: string;
  description?: string;
}

export interface WizardStepOutcome {
  step_id: string;
  status: 'satisfied' | 'not_applicable' | 'completed' | 'failed' | 'not_reached' | 'awaiting_input';
  message?: string;
  returncode?: number | null;
  process_id?: string | null;
  duration_s?: number;
}

/**
 * What the last (or current) run did, read off disk by the backend and carried
 * on the ordinary entity payload — the `Project.customization` trick. That is
 * why the UI needs no route of its own for it.
 */
export interface WizardRunState {
  status?: '' | 'running' | 'pending' | 'completed' | 'failed';
  inputs?: Record<string, unknown>;
  awaiting?: WizardAwaiting[];
  outcomes?: WizardStepOutcome[];
  message?: string;
  /** A person approved this non-shipped wizard to run shell here. Recorded so a
   *  run that PARKS for a value can be resumed without re-approving on every
   *  answer. */
  approved?: boolean;
}

export interface IWizard extends IEntity {
  asset_ref?: string;
  enabled?: boolean;
  description?: string;
  /** The agent driving this CONVERSATIONAL wizard, declared in the document.
   *
   *  Non-empty means the wizard is a conversation: it has no steps, it is
   *  launched from wherever it is offered (with the caller's prompt and
   *  payload), and there is nothing for the step runner to run. Empty means it
   *  is a stepped wizard the backend runner drives. The two are mutually
   *  exclusive — `WizardSpec` refuses a document that is both. */
  agent?: string;
  /** Ships inside Flowpad, so the runner trusts its commands. NOT the base
   *  entity's `system` flag, which is a different fact and reads false here. */
  shipped?: boolean;
  run_state?: WizardRunState;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Wizard extends EntityMerge<IWizard> {}

/**
 * An autonomous setup document — a folder asset of ordered steps, each of which
 * asks the machine a question, acts on the answer, and proves the result.
 *
 * The counterpart of Journey, and the line between them is the reason both
 * exist: a Journey PRESENTS a step and waits for a person; a Wizard DECIDES and
 * executes. A wizard parks only when it is missing a VALUE it needs, never
 * merely to be acknowledged.
 */
@registerEntity
export class Wizard extends APIEntity<Wizard> implements IWizard {
  static type: string = 'wizard';
  asset_ref?: string;
  enabled?: boolean;
  description?: string;
  /** The agent driving this CONVERSATIONAL wizard, declared in the document.
   *
   *  Non-empty means the wizard is a conversation: it has no steps, it is
   *  launched from wherever it is offered (with the caller's prompt and
   *  payload), and there is nothing for the step runner to run. Empty means it
   *  is a stepped wizard the backend runner drives. The two are mutually
   *  exclusive — `WizardSpec` refuses a document that is both. */
  agent?: string;
  /** Ships inside Flowpad, so the runner trusts its commands. NOT the base
   *  entity's `system` flag, which is a different fact and reads false here. */
  shipped?: boolean;
  run_state?: WizardRunState;

  constructor(entity: Partial<IWizard> = {}) {
    super(entity);
    this.asset_ref = entity.asset_ref;
    this.enabled = entity.enabled;
    this.description = entity.description;
    // A computed field on the backend: re-read on every fetch, never written
    // from here. The UI mirrors it, the backend owns it.
    this.agent = entity.agent;
    this.shipped = entity.shipped;
    this.run_state = entity.run_state;
  }
}

