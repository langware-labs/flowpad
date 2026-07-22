// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Journey, JourneyJournal } from '@sdk';
import { JourneyTray } from '@src/journey/JourneyTray';
import { groupSteps, type JourneyStep, type UseJourneyResult } from '@src/journey/use-journey';

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openDock: vi.fn(), highlight: vi.fn(), closeJourney: vi.fn() },
    currentDock: null,
  }),
}));

const step = (node_id: string, group?: string): JourneyStep => ({
  node_id,
  name: node_id,
  status_line: '',
  group,
  present: {},
  await: { topic: 'manual' },
});

describe('groupSteps — consecutive-group sections', () => {
  it('folds consecutive grouped steps and keeps ungrouped ones standalone', () => {
    const sections = groupSteps([
      step('a'),
      step('b', 'G1'),
      step('c', 'G1'),
      step('d', 'G2'),
      step('e'),
    ]);
    expect(sections.map((s) => [s.group, s.indices])).toEqual([
      [null, [0]],
      ['G1', [1, 2]],
      ['G2', [3]],
      [null, [4]],
    ]);
  });
});

describe('JourneyTray — grouped rendering', () => {
  it('renders group headers with indented sub-steps', () => {
    const steps = [step('s1'), step('s2', 'Create your vibe agent'), step('s3', 'Create your vibe agent')];
    const state: UseJourneyResult = {
      journey: new Journey({ id: '5eaa7e57-1111-4222-8333-444455556666', name: 'J' }),
      journal: new JourneyJournal({ status: 'launched', cursor: 's2', total_steps: 3, steps_left: 2 }),
      steps,
      currentStep: steps[1],
      cursorIndex: 1,
      loading: false,
      refresh: () => {},
    };
    render(<JourneyTray state={state} />);
    expect(screen.getByText('Create your vibe agent')).toBeTruthy();
    const grouped = document.querySelector('[data-group="Create your vibe agent"]')!;
    expect(grouped.querySelectorAll('li').length).toBe(2);
    expect(document.querySelector('[data-current]')?.textContent).toContain('s2');
  });
});
