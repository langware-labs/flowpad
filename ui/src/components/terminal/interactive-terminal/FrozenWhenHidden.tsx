import { useRef, type ReactNode } from 'react';

/**
 * Renders `children` as given while `active`; while hidden, hands React the SAME element
 * it got on the last active render, so the subtree is not reconciled again.
 *
 * A pooled panel stays alive when its tab is left, and it reads app-wide state (the URL, the
 * view mode, preferences, entities). Every change re-renders it — 26 times per tab switch
 * with no prop changed — and re-renders everything under it that is not memoized: the
 * toolbar, the gutters, the ribbon, ~1,800 tooltips per switch with five tabs, which is what
 * made a switch cost 0.1 s with two live panels and 0.55 s with five (FLOWPAD-2193).
 *
 * The decorations of a hidden panel are invisible and inert, so nothing is lost by not
 * re-rendering them until it is shown: `active` turning true is a prop change, the panel
 * re-renders, and they render once with the latest props. Built on element identity rather
 * than `memo` because these children take an inline callback or element on every render, so
 * no prop comparison would ever hold.
 *
 * Only for PRESENTATION. Anything a hidden panel must keep doing — receiving output, naming
 * its tab, noticing a finished turn — belongs outside it.
 */
export function FrozenWhenHidden({ active, children }: { active: boolean; children: ReactNode }) {
  const shown = useRef(children);
  if (active) shown.current = children;
  return <>{shown.current}</>;
}
