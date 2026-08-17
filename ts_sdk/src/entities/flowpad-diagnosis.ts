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
  // Environment snapshot of the REPORTING machine, captured at record time so it
  // still describes the reporter after the diagnosis is forwarded to a helper.
  reported_by?: string; // `Name <email>` of whoever hit the issue
  occurred_at?: string; // ISO timestamp of when the diagnosis was recorded
  os?: string; // platform.platform() of the machine the issue happened on
  app_version?: string; // Flowpad version running there
  origin_project_id?: string; // project the user was in when the diagnosis was recorded
  origin_project_name?: string; // display name of origin_project_id (travels with the record)
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
  reported_by?: string;
  occurred_at?: string;
  os?: string;
  app_version?: string;
  origin_project_id?: string;
  origin_project_name?: string;
  static type: string = 'flowpad_diagnosis';

  constructor(entity: Partial<IFlowpadDiagnosis> = {}) {
    super(entity);
    this.name = entity.name;
    this.title = entity.title;
    this.symptoms = entity.symptoms;
    this.rca = entity.rca;
    this.fix = entity.fix;
    this.summary = entity.summary;
    this.reported_by = entity.reported_by;
    this.occurred_at = entity.occurred_at;
    this.os = entity.os;
    this.app_version = entity.app_version;
    this.origin_project_id = entity.origin_project_id;
    this.origin_project_name = entity.origin_project_name;
  }
}
