/**
 * The pool holds a scroll offset only for a scroller that can still be restored.
 *
 * The pool records the offset of every element that scrolls inside it, keyed by the element,
 * so it can put the offsets back after the stack moves to another slot. An element is a strong
 * key: one entry keeps its scroller, and through it the whole panel subtree, reachable. So a
 * panel that leaves the pool — its tab closed, or an ended agent given back — takes its entries
 * with it, and an offset of a panel that stays is still restored.
 *
 * OBSERVATION POINT — the store's own `scrolled` map, read through a cast (it is private state
 * with no product reader). The real `terminalPool` singleton, driven through the public calls
 * the product makes (`setParking`, `show`, `retain`, `release`); the scroll is a real `scroll`
 * event caught by the pool's own capture listener.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { terminalPool } from '@src/components/terminal/terminal-pool';

const scrolled = () => (terminalPool as unknown as { scrolled: Map<Element, { top: number; left: number }> }).scrolled;

let parking: HTMLDivElement;
let hostOne: HTMLDivElement;
let hostTwo: HTMLDivElement;
const slotOne = Symbol('slot-one');
const slotTwo = Symbol('slot-two');

/** A panel's scroller, as React leaves it inside the pool's container, scrolled to `top`. */
function scrollerIn(key: string, top: number): HTMLDivElement {
  const scroller = document.createElement('div');
  terminalPool.container(key).appendChild(scroller);
  scroller.scrollTop = top;
  scroller.dispatchEvent(new Event('scroll'));
  return scroller;
}

beforeEach(() => {
  parking = document.body.appendChild(document.createElement('div'));
  hostOne = document.body.appendChild(document.createElement('div'));
  hostTwo = document.body.appendChild(document.createElement('div'));
  terminalPool.setParking(parking);
});

afterEach(() => {
  terminalPool.resetForTests();
  document.body.replaceChildren();
});

describe('scroll offsets of a panel that left the pool', () => {
  it('go when the tab closes, whether or not React already emptied the container', () => {
    terminalPool.show(slotOne, 'a', hostOne);
    terminalPool.show(slotOne, 'b', hostOne);
    const stillInside = scrollerIn('a', 40);
    const alreadyRemoved = scrollerIn('b', 60);
    terminalPool.show(slotOne, 'c', hostOne);
    const kept = scrollerIn('c', 80);
    expect(scrolled().size).toBe(3);

    // A tab close reaches the pool after the commit that removed the portal's children.
    alreadyRemoved.remove();
    terminalPool.retain(new Set(['c']));

    expect(scrolled().has(stillInside), 'a closed tab kept its scroller reachable').toBe(false);
    expect(scrolled().has(alreadyRemoved), 'a scroller React had removed stayed reachable').toBe(false);
    expect([...scrolled().keys()]).toEqual([kept]);
  });

  it('go when an ended agent’s panel is released behind another tab', () => {
    terminalPool.show(slotOne, 'ended', hostOne);
    const gone = scrollerIn('ended', 40);
    terminalPool.show(slotOne, 'shown', hostOne);
    const kept = scrollerIn('shown', 80);

    expect(terminalPool.release('ended')).toBe(true);

    expect(terminalPool.has('ended')).toBe(false);
    expect(gone.isConnected).toBe(false);
    expect([...scrolled().keys()]).toEqual([kept]);
  });

  it('stay for the panels that remain, and are put back when the stack moves to another slot', () => {
    terminalPool.show(slotOne, 'a', hostOne);
    const live = scrollerIn('a', 120);
    terminalPool.show(slotOne, 'b', hostOne);
    scrollerIn('b', 30);
    terminalPool.retain(new Set(['a']));

    // The browser resets a moved node's offsets; the pool restores what it recorded.
    live.scrollTop = 0;
    terminalPool.show(slotTwo, 'a', hostTwo);

    expect(hostTwo.contains(live)).toBe(true);
    expect(live.scrollTop).toBe(120);
  });

  it('are kept while the stack waits outside the document', () => {
    terminalPool.resetForTests(); // no parking: the stack has no parent yet
    const live = scrollerIn('a', 50);
    const other = scrollerIn('b', 70);

    terminalPool.retain(new Set(['a']));

    expect(live.isConnected, 'precondition: the unparked stack is outside the document').toBe(false);
    expect(scrolled().has(live), 'a live scroller in an unparked stack lost its offset').toBe(true);
    expect(scrolled().has(other)).toBe(false);
  });
});
