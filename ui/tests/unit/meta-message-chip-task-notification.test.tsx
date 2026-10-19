import { describe, expect, it } from 'vitest';

import { parseTaskNotificationSummary } from '@src/components/entity-execution-panel/MetaMessageChip';

const notification = (summary: string) =>
  `<task-notification>\n<task-id>bx0figo0o</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n` +
  `<output-file>/tmp/tasks/bx0figo0o.output</output-file>\n<status>completed</status>\n` +
  `<summary>${summary}</summary>\n</task-notification>`;

describe('MetaMessageChip — a finished background task', () => {
  it('says the one line meant for a person, not the envelope', () => {
    expect(parseTaskNotificationSummary(notification('Background command "wait" completed (exit code 0)'))).toBe(
      'Background command "wait" completed (exit code 0)',
    );
  });

  it('falls back to the generic label when the envelope has no summary', () => {
    expect(
      parseTaskNotificationSummary('<task-notification>\n<status>completed</status>\n</task-notification>'),
    ).toBeNull();
  });

  it('leaves every other framework line to the generic label', () => {
    expect(parseTaskNotificationSummary('Base directory for this skill: /x/skills/rca')).toBeNull();
    expect(parseTaskNotificationSummary('why is there a <task-notification> here?')).toBeNull();
  });
});
