import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface IAnnotation extends IEntity {
  labels?: string[];
  target_type?: string;
  target_id?: string;
  content?: string;
  session_id?: string;
  iso_timestamp?: string;
  data?: Record<string, any>;  // PTY: seq, seqOffset, line
}

@registerEntity
export class Annotation extends APIEntity<Annotation> implements IAnnotation {
  labels?: string[];
  target_type?: string;
  target_id?: string;
  content?: string;
  session_id?: string;
  iso_timestamp?: string;
  data?: Record<string, any>;
  static type: string = 'annotation';

  constructor(entity: Partial<IAnnotation> = {}) {
    super(entity);
    this.labels = entity.labels;
    this.target_type = entity.target_type;
    this.target_id = entity.target_id;
    this.content = entity.content;
    this.session_id = entity.session_id;
    this.iso_timestamp = entity.iso_timestamp;
    this.data = entity.data ||= {};
  }
}
