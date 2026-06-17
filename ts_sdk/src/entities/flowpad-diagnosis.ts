import { IEntity } from '../IEntity';
import { APIEntity, registerEntity } from '../APIEntity';

/**
 * FlowpadDiagnosis — a recorded issue diagnosis (title / symptoms / root-cause /
 * fix). Created by the assistant when it diagnoses a problem; surfaced in the
 * account settings "System Diagnoses" table. Backend type: `flowpad_diagnosis`.
 */
export interface IFlowpadDiagnosis extends IEntity {
  name?: string; // label (mirrors title)
  title?: string; // title of the diagnosis
  symptoms?: string; // what the user saw / expected (UI, console errors, misbehavior)
  rca?: string; // root cause found after debugging
  fix?: string; // what was done to resolve it
  summary?: string; // one-paragraph plain-language summary shown to the user
}

@registerEntity
export class FlowpadDiagnosis
  extends APIEntity<FlowpadDiagnosis>
  implements IFlowpadDiagnosis
{
  name?: string;
  title?: string;
  symptoms?: string;
  rca?: string;
  fix?: string;
  summary?: string;
  static type: string = 'flowpad_diagnosis';

  constructor(entity: Partial<IFlowpadDiagnosis> = {}) {
    super(entity);
    this.name = entity.name;
    this.title = entity.title;
    this.symptoms = entity.symptoms;
    this.rca = entity.rca;
    this.fix = entity.fix;
    this.summary = entity.summary;
  }
}
