import { describe, expect, it } from 'vitest';
import { describesAProblem } from '@src/components/help/describes-a-problem';

describe('describesAProblem', () => {
  it.each(['', '   ', 'hi9', 'test', 'help', '502', '!!!'])('a word or nothing is not a description: %j', (text) => {
    expect(describesAProblem(text)).toBe(false);
  });

  it.each(['the home button does not work', 'כפתור הבית לא עובד', 'Traceback (most recent call last)', 'it crashes'])(
    'a sentence or a pasted error is a description: %j',
    (text) => {
      expect(describesAProblem(text)).toBe(true);
    },
  );
});
