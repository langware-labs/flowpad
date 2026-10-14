import {
  ActionInfo,
  dataManager,
  ExitCode,
  PROCESS_CALL_TYPE,
  RETURNED_VALUE_TYPE,
  type FlowMessage,
  type ProcessCall,
  type ReturnedValue,
} from '@sdk';
import { carriedValue } from '@sdk/entities/flow-message';

/** good: it did the job · bad: it ran and says it could not · error: the run itself broke · declined: never ran. */
export type CallOutcome = 'good' | 'bad' | 'error' | 'declined';

export function processCallOf(fm: FlowMessage | null | undefined): ProcessCall | null {
  return carriedValue<ProcessCall>(fm?.attachment, PROCESS_CALL_TYPE)?.value ?? null;
}

/** Read off the answer's FIELDS — never its sentence. */
export function callOutcome(answer: ReturnedValue): CallOutcome {
  if (answer.exit_code === ExitCode.OK) return 'good';
  if (answer.exit_code === ExitCode.REFUSED) return 'declined';
  return answer.reported ? 'bad' : 'error';
}

/** A conversation's calls and answers, parsed in one pass per update: the call each message
 *  carries, each call's answer, and the messages carrying an answer — which the feed hides
 *  (an answer renders on its call's card). `unanswered`: some call still waits or runs. */
export function indexCalls(fms: Iterable<FlowMessage>): {
  callByMessage: Map<string, ProcessCall>;
  answerByCall: Map<string, ReturnedValue>;
  answerMessageIds: Set<string>;
  unanswered: boolean;
} {
  const callByMessage = new Map<string, ProcessCall>();
  const answerByCall = new Map<string, ReturnedValue>();
  const answerMessageIds = new Set<string>();
  for (const fm of fms) {
    if (!fm.id) continue;
    const call = processCallOf(fm);
    if (call) callByMessage.set(fm.id, call);
    const answer = carriedValue<ReturnedValue>(fm.attachment, RETURNED_VALUE_TYPE);
    if (answer) {
      answerByCall.set(answer.id, answer.value);
      answerMessageIds.add(fm.id);
    }
  }
  const unanswered = [...callByMessage.values()].some((c) => !answerByCall.has(c.call_id));
  return { callByMessage, answerByCall, answerMessageIds, unanswered };
}

export type CallDecision = 'approve' | 'decline' | 'stop';

/** The receiver's answer to a call: run it once, refuse it, or stop it mid-run. */
export async function decideProcessCall(conversationId: string, messageId: string, decision: CallDecision) {
  const action = new ActionInfo('process-call', 'conversation', conversationId, 'POST');
  action.bodyParameters = { message_id: messageId, decision };
  return dataManager.callAction(action);
}

/** The calls running on this machine — so a card that reloads mid-run still says "working…". */
export async function runningProcessCalls(conversationId: string): Promise<string[]> {
  const action = new ActionInfo('process-call-status', 'conversation', conversationId, 'POST');
  const data: { running?: unknown } | null = await dataManager.callAction(action);
  return Array.isArray(data?.running) ? data.running.filter((x): x is string => typeof x === 'string') : [];
}
