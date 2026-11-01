import { describe, expect, it } from 'vitest';
import { prefsAfterAnswer, shouldAsk } from '@src/components/diagnose/SendOnceDoneDialog';

describe('Send report once done', () => {
  it('asks only when someone is picked, the box is off, and asking is on', () => {
    expect(shouldAsk(1, false, true)).toBe(true);
    expect(shouldAsk(0, false, true)).toBe(false);
    expect(shouldAsk(1, true, true)).toBe(false);
    expect(shouldAsk(1, false, false)).toBe(false);
  });

  it('"Remember this decision" makes the answer the checkbox default', () => {
    expect(prefsAfterAnswer({ send: true, remember: true, dontShowAgain: false })).toEqual({ sendWhenDone: true });
    expect(prefsAfterAnswer({ send: false, remember: true, dontShowAgain: false })).toEqual({ sendWhenDone: false });
  });

  it('"Don\'t show again" stops the question and leaves the default alone', () => {
    expect(prefsAfterAnswer({ send: true, remember: false, dontShowAgain: true })).toEqual({ askBeforeSend: false });
  });

  it('a plain answer writes nothing', () => {
    expect(prefsAfterAnswer({ send: true, remember: false, dontShowAgain: false })).toEqual({});
  });
});
