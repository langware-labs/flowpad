// A column's meaning shows on hover in a box the page draws itself: a native `title` tooltip does
// not appear inside an app's iframe in the desktop app.
import { describe, expect, it } from 'vitest';

import { h, installTooltips } from '../../../ts_sdk/src/viewers/dom';

describe('viewer tooltips', () => {
  it('hovering anything with a title shows its text in the page, and no native tooltip doubles it', () => {
    installTooltips();
    const th = h('th', { title: 'How often it opened the right thing.' }, 'precision');
    document.body.append(th);
    th.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(document.querySelector('.dv-tip')?.textContent).toBe('How often it opened the right thing.');
    expect(th.hasAttribute('title')).toBe(false);

    document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(document.querySelector('.dv-tip')).toBeNull();
    th.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(document.querySelector('.dv-tip')?.textContent).toBe('How often it opened the right thing.');
  });
});
