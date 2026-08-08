import { describe, expect, it } from 'vitest';
import {
  JourneyGraph,
  matchesElement,
  matchesLocation,
  waitConditionProblems,
  type JourneyWaitCondition,
} from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@sdk';
import { journeyStep } from '../utils/journey-fixtures';

/**
 * `waitFor` is ONE vocabulary for every kind of "not yet". These tests pin the
 * pure half of it — the matchers and the authoring validator — which is all of
 * it that can be decided without a DOM or a store.
 */

describe('a step must say what it waits for', () => {
  it('an empty waitFor is an authoring error', () => {
    const graph = new JourneyGraph({ steps: [journeyStep('s1', { waitFor: [] })] });
    expect(graph.problems().join('\n')).toContain('waitFor is required');
  });
});

describe('matchesLocation', () => {
  const shell = new DockPointer(ViewType.SHELL, 'agentic_process-1').withViewMode('standard' as never);

  it('matches an option', () => {
    expect(matchesLocation(shell, { options: { viewMode: 'standard' } })).toBe(true);
    expect(matchesLocation(shell, { options: { viewMode: 'vibe' } })).toBe(false);
  });

  it('a null option value asserts ABSENCE', () => {
    expect(matchesLocation(shell, { options: { highlight: null } })).toBe(true);
    expect(matchesLocation(shell, { options: { viewMode: null } })).toBe(false);
  });

  it('matches the view type and pointer', () => {
    expect(matchesLocation(shell, { viewType: ViewType.SHELL })).toBe(true);
    expect(matchesLocation(shell, { viewType: ViewType.ASSETS })).toBe(false);
    expect(matchesLocation(shell, { pointer: 'agentic_process-1' })).toBe(true);
  });

  it('knows the app root', () => {
    expect(matchesLocation(DockPointer.root(), { root: true })).toBe(true);
    expect(matchesLocation(shell, { root: true })).toBe(false);
    expect(matchesLocation(shell, { root: false })).toBe(true);
  });

  it('every given field must hold', () => {
    expect(matchesLocation(shell, { viewType: ViewType.SHELL, options: { viewMode: 'vibe' } })).toBe(false);
  });

  it('nowhere matches nothing', () => {
    expect(matchesLocation(null, { root: true })).toBe(false);
  });
});

describe('matchesElement', () => {
  const doc = (html: string): Document => {
    const d = document.implementation.createHTMLDocument('t');
    d.body.innerHTML = html;
    return d;
  };

  it('present', () => {
    expect(matchesElement({ present: 'VibeDisplay' }, doc('<div data-tag="VibeDisplay"></div>'))).toBe(true);
    expect(matchesElement({ present: 'VibeDisplay' }, doc('<div></div>'))).toBe(false);
  });

  it('gone — the condition a vibe-exit probe actually means', () => {
    expect(matchesElement({ gone: 'VibeDisplay' }, doc('<div></div>'))).toBe(true);
    expect(matchesElement({ gone: 'VibeDisplay' }, doc('<div data-tag="VibeDisplay"></div>'))).toBe(false);
  });

  it('both at once', () => {
    const d = doc('<div data-tag="ViewToggle"></div>');
    expect(matchesElement({ present: 'ViewToggle', gone: 'VibeDisplay' }, d)).toBe(true);
  });
});

describe('waitConditionProblems', () => {
  const at = (c: JourneyWaitCondition) => waitConditionProblems(c, 'step 0').join('\n');

  it('is silent on well-formed conditions', () => {
    expect(at({ click: 'X' })).toBe('');
    expect(at({ element: { gone: 'Y' } })).toBe('');
    expect(at({ any: [{ click: 'X' }, { manual: true }] })).toBe('');
  });

  it('catches an unknown kind', () => {
    expect(at({ teleport: 'X' } as never)).toContain('unknown waitFor condition "teleport"');
  });

  it('catches an empty group and an empty element match', () => {
    expect(at({ any: [] })).toContain('needs at least one condition');
    expect(at({ element: {} })).toContain('needs "present" or "gone"');
  });

  it('recurses into groups', () => {
    expect(at({ all: [{ click: '' }] })).toContain('click condition needs a tag word');
  });
});
