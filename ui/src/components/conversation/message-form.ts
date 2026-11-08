import { ActionInfo, dataManager, type FlowMessage } from '@sdk';
import { carriedValue } from '@sdk/entities/flow-message';

/** Mirrors `flow_sdk/schema/data_spec/message_form_spec.py`. */
export const MESSAGE_FORM_TYPE = 'message_form';
export const FORM_ANSWERS_TYPE = 'form_answers';

export type FormFieldType =
  | 'text'
  | 'long_text'
  | 'number'
  | 'date'
  | 'one'
  | 'many'
  | 'yesno'
  | 'buttons'
  | 'select'
  | 'file';

export type FormValue = string | number | boolean | string[];

export interface FormField {
  id: string;
  label: string;
  type: FormFieldType;
  options?: string[];
  default?: FormValue | null;
  optional?: boolean;
  min?: number | null;
  max?: number | null;
  hint?: string | null;
}

export interface MessageForm {
  form_id: string;
  title: string;
  fields: FormField[];
}

export interface FormAnswers {
  form_id: string;
  values: Record<string, FormValue>;
  changed?: string[];
  supersedes?: string | null;
}

/** One answers message: who sent it, when, and what it says. */
export interface AnswersEntry {
  messageId: string;
  answers: FormAnswers;
  at: string;
  /** The answers this one replaced — for the "was …" on changed rows. */
  previous: FormAnswers | null;
}

export function formOf(fm: FlowMessage | null | undefined): MessageForm | null {
  const v = carriedValue<MessageForm>(fm?.attachment, MESSAGE_FORM_TYPE)?.value;
  return v && Array.isArray(v.fields) ? v : null;
}

export function formAnswersOf(fm: FlowMessage | null | undefined): FormAnswers | null {
  const v = carriedValue<FormAnswers>(fm?.attachment, FORM_ANSWERS_TYPE)?.value;
  return v && v.values && typeof v.values === 'object' ? v : null;
}

const stamp = (fm: FlowMessage) =>
  fm.created_date instanceof Date ? fm.created_date.toISOString() : String(fm.created_date ?? '');

/** A conversation's forms and their answers in one pass: the form each message carries, and
 *  per form its answers oldest → newest (the last one is the answer). */
export function indexForms(fms: Iterable<FlowMessage>): {
  formByMessage: Map<string, MessageForm>;
  formById: Map<string, MessageForm>;
  answersByForm: Map<string, AnswersEntry[]>;
  answersByMessage: Map<string, AnswersEntry>;
} {
  const formByMessage = new Map<string, MessageForm>();
  const formById = new Map<string, MessageForm>();
  const raw: { messageId: string; answers: FormAnswers; at: string }[] = [];
  for (const fm of fms) {
    if (!fm.id) continue;
    const form = formOf(fm);
    if (form) {
      formByMessage.set(fm.id, form);
      formById.set(form.form_id, form);
    }
    const answers = formAnswersOf(fm);
    if (answers) raw.push({ messageId: fm.id, answers, at: stamp(fm) });
  }
  raw.sort((a, b) => a.at.localeCompare(b.at));
  const answersByForm = new Map<string, AnswersEntry[]>();
  const answersByMessage = new Map<string, AnswersEntry>();
  for (const r of raw) {
    const list = answersByForm.get(r.answers.form_id) ?? [];
    const entry: AnswersEntry = { ...r, previous: list.at(-1)?.answers ?? null };
    list.push(entry);
    answersByForm.set(r.answers.form_id, list);
    answersByMessage.set(r.messageId, entry);
  }
  return { formByMessage, formById, answersByForm, answersByMessage };
}

const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Labels of the required fields still empty — Submit stays off while any is left. */
export function leftToFill(form: MessageForm, values: Record<string, FormValue | undefined>): string[] {
  return form.fields.filter((f) => !f.optional && empty(values[f.id])).map((f) => f.label);
}

/** The values a form opens with: the latest answers, else the sender's defaults. */
export function initialValues(form: MessageForm, latest: FormAnswers | null): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  for (const f of form.fields) {
    const v = latest ? latest.values[f.id] : f.default;
    if (!empty(v)) out[f.id] = v as FormValue;
  }
  return out;
}

/** A value as a person reads it. */
export function shownValue(v: FormValue | undefined | null, yes: string, no: string): string {
  if (v === true) return yes;
  if (v === false) return no;
  if (Array.isArray(v)) return v.join(', ');
  return v === undefined || v === null ? '' : String(v);
}

/** Submit: one reply carrying the answers (and a `file` field's upload). */
export async function submitFormAnswers(
  conversationId: string,
  messageId: string,
  values: Record<string, FormValue>,
  files: File[],
) {
  const action = new ActionInfo('form-answer', 'conversation', conversationId, 'POST');
  if (files.length) {
    const body = new FormData();
    body.append('message_id', messageId);
    body.append('values', JSON.stringify(values));
    for (const f of files) body.append('files', f, f.name);
    action.bodyParameters = body;
  } else {
    action.bodyParameters = { message_id: messageId, values };
  }
  return dataManager.callAction(action);
}

/** "Change answers" on an answers card reopens its form card (the two are separate bubbles). */
export const FORM_EDIT_EVENT = 'flow-form-edit';
