/**
 * A message rule's THEN as steps the person builds, and the words a tag rule and the message
 * classifier read as in the list.
 */
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { RuleStep, WhenPart } from '@sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sentenceOf, useAutomationWords } from '@src/components/automations/automation-words';
import { missingInSteps, ThenStepsEditor } from '@src/components/automations/ThenStepsEditor';

afterEach(cleanup);

const agents = [{ id: 'a1', name: 'Billing helper' }];
function editor(steps: RuleStep[]) {
  const onChange = vi.fn();
  render(<ThenStepsEditor steps={steps} onChange={onChange} agents={agents} />);
  return onChange;
}

describe('the steps editor', () => {
  it.each(['mark_read', 'run_script', 'run_agent', 'prompt'] as const)('adds a %s step at the end', (kind) => {
    const onChange = editor([{ kind: 'mark_read' }]);
    fireEvent.click(screen.getByTestId('rule-step-add'));
    fireEvent.click(screen.getByTestId(`rule-step-kind-${kind}`));
    expect(onChange).toHaveBeenCalledWith([{ kind: 'mark_read' }, { kind }]);
  });

  it('edits each step in place, and the first agent step keeps the old ids', () => {
    const steps: RuleStep[] = [{ kind: 'run_agent', agent: '', prompt: '' }, { kind: 'run_script', script: '' }, { kind: 'prompt', prompt: '' }];
    const onChange = editor(steps);
    expect(screen.getAllByTestId(/^rule-step-\d$/).map((row) => row.getAttribute('data-kind'))).toEqual(['run_agent', 'run_script', 'prompt']);
    fireEvent.change(screen.getByTestId('message-rule-agent'), { target: { value: 'agent-a1' } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...steps[0], agent: 'agent-a1' }, steps[1], steps[2]]);
    fireEvent.change(screen.getByTestId('message-rule-prompt'), { target: { value: 'Draft it' } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...steps[0], prompt: 'Draft it' }, steps[1], steps[2]]);
    fireEvent.change(screen.getByTestId('rule-step-script-1'), { target: { value: './log.sh' } });
    expect(onChange).toHaveBeenLastCalledWith([steps[0], { kind: 'run_script', script: './log.sh' }, steps[2]]);
    fireEvent.change(screen.getByTestId('rule-step-prompt-2'), { target: { value: 'Sum it up' } });
    expect(onChange).toHaveBeenLastCalledWith([steps[0], steps[1], { kind: 'prompt', prompt: 'Sum it up' }]);
  });

  it('moves a step up or down and removes it', () => {
    const [a, b, c]: RuleStep[] = [{ kind: 'mark_read' }, { kind: 'run_script', script: 'x' }, { kind: 'prompt', prompt: 'p' }];
    const onChange = editor([a, b, c]);
    fireEvent.click(screen.getByTestId('rule-step-up-1'));
    expect(onChange).toHaveBeenLastCalledWith([b, a, c]);
    fireEvent.click(screen.getByTestId('rule-step-down-1'));
    expect(onChange).toHaveBeenLastCalledWith([a, c, b]);
    fireEvent.click(screen.getByTestId('rule-step-remove-0'));
    expect(onChange).toHaveBeenLastCalledWith([b, c]);
    expect(screen.getByTestId('rule-step-up-0')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('rule-step-down-2')).toHaveProperty('disabled', true);
  });

  it('says what each step still needs', () => {
    expect(missingInSteps([])).toEqual(['steps']);
    expect(missingInSteps([{ kind: 'run_agent' }, { kind: 'run_script', script: ' ' }])).toEqual(['agent', 'prompt', 'script']);
    expect(missingInSteps([{ kind: 'mark_read' }, { kind: 'prompt', prompt: 'p' }, { kind: 'run_agent', agent: 'agent-a1', prompt: 'p' }])).toEqual([]);
  });
});

describe('the words', () => {
  const event = (message_tags?: string[]): WhenPart => ({
    kind: 'event',
    text: '',
    event: { pattern: 'stream_inbox.*.message.projected', title: '', description: '', message_tags },
  });
  const words = () => renderHook(() => useAutomationWords()).result.current;

  it('a tag rule names its tags; without tags it is a message arriving', () => {
    expect(words().when(event(['inbox.billing']))).toBe('When a message is tagged billing');
    expect(words().when(event(['inbox.billing', 'bug']))).toBe('When a message is tagged billing or bug');
    expect(words().when(event())).toBe('When a message arrives');
  });

  it('the classifier reads: a message arrives → classify it', () => {
    expect(sentenceOf(words(), event(), [], true)).toEqual({ when: 'a message arrives', then: 'classify it' });
  });
});
