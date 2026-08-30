import type { EntityMerge } from '../IEntity';
import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export type QuestionStatus = 'received' | 'pending' | 'sent' | 'discarded';

export interface IQuestion extends IEntity {
  question: string;
  answer?: string;
  status: QuestionStatus;
  reporter?: string;
  reviewer?: string;
}

// `implements IQuestion` only checks the class; it contributes no members, so every
// field declared solely on IQuestion read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Question extends EntityMerge<IQuestion> {}

@registerEntity
export class Question extends APIEntity<Question> implements IQuestion {
  static type: string = 'question';
  question: string;
  answer?: string;
  status: QuestionStatus;
  reporter?: string;
  reviewer?: string;

  constructor(entity: Partial<IQuestion> = {}) {
    super(entity);
    this.question = entity.question ||= '';
    this.answer = entity.answer;
    this.status = entity.status || 'received';
    this.reporter = entity.reporter;
    this.reviewer = entity.reviewer;
  }
}
