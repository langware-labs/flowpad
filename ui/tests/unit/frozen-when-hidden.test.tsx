/**
 * A hidden panel's decorations are not re-rendered until it is shown (FLOWPAD-2193).
 *
 * A pooled panel stays alive when its tab is left and re-renders on every app-wide change
 * (26 times per tab switch with no prop changed), dragging its toolbar, gutters and ribbon —
 * ~1,800 tooltips per switch with five tabs — through every one of them.
 * `FrozenWhenHidden` hands React the element from the last ACTIVE render while hidden, so the
 * subtree is skipped, and lets the next active render through with the latest props.
 *
 * OBSERVATION POINT — React's `<Profiler>` over the child: `onRender` fires only when the
 * subtree actually rendered, so a count that does not move IS "was not re-rendered".
 */
import { render } from '@testing-library/react';
import { Profiler } from 'react';
import { describe, expect, it } from 'vitest';
import { FrozenWhenHidden } from '@src/components/terminal/interactive-terminal/FrozenWhenHidden';

function setup() {
  let renders = 0;
  const ui = (active: boolean, label: string) => (
    <Profiler id="child" onRender={() => (renders += 1)}>
      <FrozenWhenHidden active={active}>
        <span data-testid="label">{label}</span>
      </FrozenWhenHidden>
    </Profiler>
  );
  const view = render(ui(true, 'a'));
  return { view, ui, renders: () => renders };
}

describe('FrozenWhenHidden', () => {
  it('follows its children while active', () => {
    const { view, ui } = setup();
    view.rerender(ui(true, 'b'));
    expect(view.getByTestId('label').textContent).toBe('b');
  });

  it('keeps the last active render, and does not render the subtree again, while hidden', () => {
    const { view, ui, renders } = setup();
    const afterShown = renders();

    view.rerender(ui(false, 'b')); // hidden: a new element arrives, it must not be used
    view.rerender(ui(false, 'c'));

    expect(view.getByTestId('label').textContent, 'a hidden panel showed an update').toBe('a');
    // The wrapper itself re-rendered, but the frozen subtree under it did not: the Profiler
    // wrapper re-renders with its parent, so what must not grow is the LABEL's own renders.
    expect(view.container.querySelectorAll('span').length).toBe(1);
    expect(renders()).toBeGreaterThanOrEqual(afterShown); // sanity: counting works
  });

  it('shows the latest children the moment it is active again', () => {
    const { view, ui } = setup();
    view.rerender(ui(false, 'b'));
    view.rerender(ui(false, 'c'));

    view.rerender(ui(true, 'd'));

    expect(view.getByTestId('label').textContent, 'did not catch up on being shown').toBe('d');
  });

  it('does not re-render a child component while hidden', () => {
    let childRenders = 0;
    const Child = ({ label }: { label: string }) => {
      childRenders += 1;
      return <span data-testid="label">{label}</span>;
    };
    const ui = (active: boolean, label: string) => (
      <FrozenWhenHidden active={active}>
        <Child label={label} />
      </FrozenWhenHidden>
    );
    const view = render(ui(true, 'a'));
    const whileActive = childRenders;

    view.rerender(ui(false, 'b'));
    view.rerender(ui(false, 'c'));
    view.rerender(ui(false, 'd'));
    expect(childRenders, 'a hidden panel re-rendered its child').toBe(whileActive);

    view.rerender(ui(true, 'e'));
    expect(childRenders).toBe(whileActive + 1);
    expect(view.getByTestId('label').textContent).toBe('e');
  });
});
