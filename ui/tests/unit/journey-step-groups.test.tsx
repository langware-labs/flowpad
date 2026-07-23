// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

afterEach(cleanup);
import { Journey, JourneyJournal } from '@sdk';
import { JourneyTray } from '@src/journey/JourneyTray';
import { groupSteps, type JourneyStep, type UseJourneyResult } from '@src/journey/use-journey';

const closeJourney = vi.fn();
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openDock: vi.fn(), highlight: vi.fn(), closeJourney },
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
    // The tray opens COLLAPSED (current step only); the group header stays.
    expect(screen.getByText('Create your vibe agent')).toBeTruthy();
    const collapsed = document.querySelector('[data-group="Create your vibe agent"]')!;
    expect(collapsed.querySelectorAll('li').length).toBe(1);
    expect(document.querySelector('[data-current]')?.textContent).toContain('s2');

    // Expanded, the whole group renders as indented sub-steps.
    fireEvent.click(screen.getByTestId('journey-tray-expand'));
    const grouped = document.querySelector('[data-group="Create your vibe agent"]')!;
    expect(grouped.querySelectorAll('li').length).toBe(2);
  });
});

describe('JourneyTray — draggable header + minimize-to-badge', () => {
  const makeState = (): UseJourneyResult => {
    const steps = [step('s1')];
    return {
      journey: new Journey({ id: '5eaa7e57-1111-4222-8333-444455556666', name: 'J' }),
      journal: new JourneyJournal({ status: 'launched', cursor: 's1', total_steps: 1, steps_left: 1 }),
      steps,
      currentStep: steps[0],
      cursorIndex: 0,
      loading: false,
      refresh: () => {},
    };
  };

  it('the header is the drag handle; a stored position wins over the default anchor', () => {
    // Real pointer-capture dragging is browser-validated (jsdom has no faithful
    // PointerEvent); here we pin the contract: handle present + persisted
    // position applied as inline left/top instead of the bottom-left anchor.
    localStorage.setItem('flowpad.journey.tray.position', JSON.stringify({ x: 120, y: 80 }));
    render(<JourneyTray state={makeState()} />);
    const handle = screen.getByTestId('journey-tray-drag-handle');
    expect(handle.className).toContain('cursor-grab');
    const tray = screen.getByTestId('journey-tray');
    expect(tray.style.left).toBe('120px');
    expect(tray.style.top).toBe('80px');
    expect(tray.className).not.toContain('bottom-4');
    localStorage.removeItem('flowpad.journey.tray.position');
  });

  it('X minimizes: closes the journey (immediately when no badge is mounted)', () => {
    closeJourney.mockClear();
    render(<JourneyTray state={makeState()} />);
    fireEvent.click(screen.getByTestId('journey-tray-close'));
    expect(closeJourney).toHaveBeenCalledTimes(1);
  });
});
