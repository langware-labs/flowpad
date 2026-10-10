/**
 * The Automations address: place in the pointer, selection in options, and old
 * Events links landing on the same automation.
 */
import { describe, expect, it } from 'vitest';
import { ViewType } from '@sdk';
import { normalizeRetiredDockPointer } from '@sdk/utils/ui/retired-views';
import { DockPointer } from '@src/navigation/DockPointer';
import { automationsOptions, parseAutomationsRoute } from '@src/components/automations/automations-pointer';

describe('automations route', () => {
  it.each([
    [{ place: 'list' }, '/dock/automations'],
    [{ trigger: 'abc' }, '/dock/automations?trigger=abc'],
    [{ trigger: 'abc', tab: 'runs' }, '/dock/automations?trigger=abc&tab=runs'],
    [
      { creating: 'schedule', recipe: 'morning-briefing' },
      '/dock/automations?creating=schedule&recipe=morning-briefing',
    ],
    [
      { creating: 'message', source: 'ds-1', message: 'm-1' },
      '/dock/automations?creating=message&source=ds-1&message=m-1',
    ],
    [{ place: 'runs', status: 'failed' }, '/dock/automations/runs?status=failed'],
    [{ place: 'bus', tag: 'app.ready' }, '/dock/automations/bus?tag=app.ready'],
  ] as const)('%o ↔ %s', (route, url) => {
    const dock = DockPointer.forAutomations(route);
    expect(dock.toUrl('/')).toBe(url);
    const back = DockPointer.fromUrl(`http://localhost${url}`);
    expect(back.viewType).toBe(ViewType.AUTOMATIONS);
    expect(parseAutomationsRoute(back.pointer, back.options)).toMatchObject(route);
  });

  it('an unknown place or value falls back to the list, never a blank pane', () => {
    expect(parseAutomationsRoute('nonsense', { creating: 'wizard', status: 'weird' })).toMatchObject({
      place: 'list',
      creating: null,
      status: null,
    });
  });

  it('the Setup tab is the default and is not written', () => {
    expect(automationsOptions({ place: 'list', trigger: 'x', tab: 'setup' })).toEqual({ trigger: 'x' });
  });

  it('every level is one tab', () => {
    expect(DockPointer.forAutomations({ place: 'runs' }).tabHash).toBe(DockPointer.forAutomations().tabHash);
  });
});

describe('old Events links', () => {
  it.each([ViewType.EVENTS, ViewType.TRIGGERS, ViewType.CRON])('%s lands on the automations list', (viewType) => {
    expect(normalizeRetiredDockPointer({ viewType, pointer: '' })).toMatchObject({
      viewType: ViewType.AUTOMATIONS,
      pointer: '',
    });
  });

  it('the old bus monitor lands on the event bus', () => {
    expect(normalizeRetiredDockPointer({ viewType: ViewType.SIGNALS, pointer: '' })).toMatchObject({
      viewType: ViewType.AUTOMATIONS,
      pointer: 'bus',
    });
  });
});
