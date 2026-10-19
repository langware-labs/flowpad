import { ExitCode, type ReturnedValue } from '../models/ReturnedValue';

const codes = new Set<number>(Object.values(ExitCode));

/** Validate the shared FlowCall contract without stripping subtype or future fields. */
export function readFlowAnswer(value: unknown): ReturnedValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid FlowCall answer: expected an object');
  }
  const answer = value as Record<string, unknown>;
  if (answer.value_present != null && typeof answer.value_present !== 'boolean') {
    throw new Error('Invalid FlowCall answer: value_present must be boolean or null');
  }
  if (typeof answer.exit_code !== 'number' || !codes.has(answer.exit_code)) {
    throw new Error('Invalid FlowCall answer: unknown or missing exit_code');
  }
  for (const field of ['ran', 'busy', 'timed_out', 'reported']) {
    if (answer[field] !== undefined && typeof answer[field] !== 'boolean') {
      throw new Error(`Invalid FlowCall answer: ${field} must be boolean`);
    }
  }
  for (const field of ['detail', 'spec_kind']) {
    if (answer[field] !== undefined && typeof answer[field] !== 'string') {
      throw new Error(`Invalid FlowCall answer: ${field} must be a string`);
    }
  }
  if (answer.executor != null && typeof answer.executor !== 'string') {
    throw new Error('Invalid FlowCall answer: executor must be a string or null');
  }
  if (answer.invocation_id != null && typeof answer.invocation_id !== 'string') {
    throw new Error('Invalid FlowCall answer: invocation_id must be a string or null');
  }
  if (answer.duration_s !== undefined && (typeof answer.duration_s !== 'number' || !Number.isFinite(answer.duration_s))) {
    throw new Error('Invalid FlowCall answer: duration_s must be finite');
  }
  return value as ReturnedValue;
}

/** Only legacy admission responses may carry an ordinary outcome inside FAIL. */
export function readFlowEnvelope(value: unknown): ReturnedValue {
  const envelope = value as { status?: unknown; message?: unknown; data?: unknown } | null;
  if (envelope?.status === 'SUCCESS') return readFlowAnswer(envelope.data);
  if (envelope?.status === 'FAIL') {
    const answer = readFlowAnswer(envelope.data);
    if (answer.exit_code === ExitCode.NOT_YET && answer.busy === true && answer.ran === false) return answer;
  }
  throw new Error(String(envelope?.message ?? 'Invalid FlowCall response envelope'));
}
