import { describe, expect, it } from 'vitest';

import { score, type Row } from '../manual_regression/smart-navigation/navigation_scoring';

const row = (target: string): Row => ({ group: 'x', n: 1, sentence: 's', target });
const opened = (path: string) => new URL(path, 'http://localhost');

describe('navigation sentences scoring', () => {
  it('an asset opened in its project editor is the entity landed on', () => {
    const at = opened('/dock/project/c9eb/editor/skill/typeid/skill-2408c41c-b3a4-42fe-8868-243b2ff11aae');
    expect(score(row('entity:skill'), at, false, null).verdict).toBe(1);
    expect(score(row('entity:credential'), at, false, null).verdict).toBe(2);
  });

  it('the assets editor still counts', () => {
    expect(score(row('entity:task'), opened('/dock/assets/editor/task/typeid/task-1'), false, null).verdict).toBe(1);
  });

  it('an external url opened in the in-app web view works', () => {
    const at = opened('/dock/web-app/url/aHR0cHMlM0ElMkYlMkZhcHAuZmxvd3BhZC5haSUyRg');
    expect(score(row('url:https://app.flowpad.ai'), at, false, null).verdict).toBe(1);
    expect(score(row('url:https://example.com'), at, false, null).verdict).toBe(2);
  });

  it('a /win/ page counts when it popped out as a window', () => {
    expect(score(row('/win/assistant'), opened('/'), false, null, '/win/assistant').verdict).toBe(1);
    expect(score(row('/win/assistant'), opened('/'), false, null).verdict).toBe(2);
  });

  it('asking the assistant is never landing', () => {
    const at = opened('/dock/project/p/editor/skill/typeid/skill-1');
    expect(score(row('entity:skill'), at, true, null).verdict).toBe(2);
  });
});
