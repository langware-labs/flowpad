import { APIEntity, dataManager, registerEntity } from '../../APIEntity';
import { IEntity, EntityMerge } from '../../IEntity';
import { ActionInfo } from '../../models/ActionInfo';

/** One value a parked run is blocked on, with enough to draw a field. */
export interface WizardAwaiting {
  name: string;
  /** The declared shape in authoring form — `"string"`, an object, a one-element list. */
  shape?: unknown;
  label?: string;
  description?: string;
}

/** ONE command a step ran, with what it printed.
 *
 *  A step runs up to three commands — precondition, action, verify — so a flat
 *  `command`/`stdout` pair on the outcome would have to pick one. Streams are
 *  tail-capped by the backend (`truncated` says so); the END is kept, because
 *  that is where the error is. */
export interface WizardStepProbe {
  phase: 'precondition' | 'action' | 'verify';
  /** The RESOLVED command for this platform, not the per-OS map. */
  command: string;
  returncode?: number | null;
  timed_out?: boolean;
  duration_s?: number;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
}

/** One problem with a wizard document.
 *
 *  `loc` is pydantic's own — `['steps', 3, 'command', 'commands']` addresses a
 *  field the form is already rendering, which is why validation lives on the
 *  backend instead of being duplicated here. */
export interface WizardIssue {
  loc?: (string | number)[];
  msg: string;
  type?: string;
  /** `error` blocks the write; `warning` is advisory — a document that is legal
   *  but will not do what its author expects. */
  severity?: 'error' | 'warning';
}

/** The backend's verdict on a candidate document. */
export interface WizardValidation {
  ok: boolean;
  issues?: WizardIssue[];
  /** A shipped wizard cannot be edited. The frontend takes this answer from the
   *  backend rather than deciding it itself. */
  read_only?: boolean;
  read_only_reason?: string;
}

export interface WizardStepOutcome {
  step_id: string;
  status: 'satisfied' | 'not_applicable' | 'completed' | 'failed' | 'not_reached' | 'awaiting_input';
  message?: string;
  returncode?: number | null;
  process_id?: string | null;
  duration_s?: number;
  /** Every command this step ran. Present ONLY on `runDetail()` — `run_state`
   *  strips them, because it rides every row of a list and every WS push. */
  probes?: WizardStepProbe[];
}

/** The whole run record for one wizard, probes included. */
export interface WizardRunDetail {
  status?: string;
  message?: string;
  inputs?: Record<string, unknown>;
  awaiting?: WizardAwaiting[];
  outcomes?: WizardStepOutcome[];
  /** Filenames of runs previous resets archived, newest first. Their presence
   *  is what tells a reader the current record is not the whole history. */
  archived?: string[];
}

/**
 * What the last (or current) run did, read off disk by the backend and carried
 * on the ordinary entity payload — the `Project.customization` trick. That is
 * why the UI needs no route of its own for it.
 */
export interface WizardRunState {
  /** No `running`: nothing writes it. A run in flight is visible through the
   *  Activity tree, not here — this file is only stamped when a run SETTLES or
   *  parks. Advertising a state the backend never mints sent readers looking
   *  for a live signal that was never going to arrive. */
  status?: '' | 'pending' | 'completed' | 'failed';
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
  /** Why this wizard has no steps, or `''`. The reader deliberately swallows a
   *  malformed `wizard.json` (one bad document must not wedge an indexer
   *  walking a hundred assets), which made "I saved it and my wizard
   *  disappeared" indistinguishable from "there was never a wizard here". */
  document_error?: string;
  /** The Activity ROOT address this wizard's run reports under. On the payload
   *  so the frontend does not re-derive the backend's slug convention — two
   *  spellings of one address is how a viewer ends up subscribed to a tree
   *  nothing writes to. */
  activity_path?: string;
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
  document_error?: string;
  activity_path?: string;

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
    this.document_error = entity.document_error;
    this.activity_path = entity.activity_path;
  }

  /**
   * `run_state` is REPLACED wholesale, never merged.
   *
   * `DataManager.deepAssign` recurses into arrays and objects and merges them
   * by key/index, never shrinking the target — so a run record that gets
   * SMALLER is corrupted by a refresh. Reset is exactly that case: the backend
   * clears `inputs`, `awaiting` and `outcomes`, and merging `[]` over the old
   * arrays left every one of them on screen. Only `status`, a scalar, actually
   * cleared, so the viewer showed the answers and steps of a run that no longer
   * existed.
   *
   * `onEntityUpdate` runs BEFORE `deepAssign` on the cached path, so the field
   * has to be stripped from the payload, not merely assigned. Same guard the
   * codebase already uses for `AgenticProcess.queue` and `process_hook_events`.
   */
  protected onEntityUpdate(data: Partial<IWizard>): void {
    if ('run_state' in data) {
      this.run_state = data.run_state;
      delete data.run_state;
    }
  }

  /**
   * Is this document legal? Asked BEFORE the bytes hit disk.
   *
   * Pass a candidate to check an unsaved draft; pass nothing to validate what
   * is on disk. The backend answers 200 either way with the verdict in the
   * body — a non-2xx would make the caller dig its error list out of a thrown
   * exception, which is where error lists go to be lost.
   */
  async validateDocument(document?: unknown): Promise<WizardValidation> {
    const action = new ActionInfo('validate', Wizard.type, this.id, 'POST');
    action.bodyParameters = document === undefined ? {} : { document };
    return await dataManager.callAction<Record<string, unknown>, WizardValidation>(action);
  }

  /** The run record WITH per-command probes — the only place they are served. */
  async runDetail(): Promise<WizardRunDetail> {
    const action = new ActionInfo('run-detail', Wizard.type, this.id, 'GET');
    return await dataManager.callAction<void, WizardRunDetail>(action);
  }

  /**
   * Archive this run and start the record fresh.
   *
   * Refuses (409) while a run holds the wizard's lock. Approval is PRESERVED:
   * it records that a person trusts this wizard to run shell on this machine,
   * which is a fact about the wizard, not about one run's answers.
   */
  async resetRun(): Promise<WizardRunState> {
    const action = new ActionInfo('reset', Wizard.type, this.id, 'POST');
    action.bodyParameters = {};
    return await dataManager.callAction<Record<string, unknown>, WizardRunState>(action);
  }
}

