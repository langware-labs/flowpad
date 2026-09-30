/**
 * The terminal pool — a runtime (xterm + PTY attach) lives as long as its TAB,
 * not as long as the layout that happens to show it (docs/navigation/dock-loading.md, I6).
 *
 * Every terminal panel is rendered ONCE, by `<TerminalPool/>` (mounted above every
 * layout in RootLayout), through a React portal into a container `div` the pool
 * owns. All containers live in one STACK element, full size, one over another; a
 * switch between tabs only changes which panel is visible (`TerminalPanel` hides
 * the rest with `visibility: hidden`). Nothing is moved on a switch, so the
 * browser keeps every panel's layout and scroll position — a panel is never
 * re-laid-out because the user looked at another one.
 *
 * A body that shows a terminal — `TabbedTerminal`, in whichever layout the URL
 * picked — is only a SLOT. The stack sits inside the slot that showed last, so
 * the browser places it; only when the SLOT itself changes (a different layout,
 * or none) does the whole stack move, once. With no slot on screen it waits in
 * the pool's parking element: hidden, still in the document, and FULL size — a
 * 0×0 parking reflowed a long chat at zero width (every character its own line;
 * 11M px tall for a 42 MB transcript) and froze the UI for seconds on every
 * switch away from it (FLOWPAD-2193).
 *
 * Moving a node resets the scroll offsets inside it, so the pool records each
 * scroller's offset as it scrolls and puts it back when the stack lands in a slot.
 *
 * A second slot on screen at the same time (rare: an editor's terminal strip
 * while another slot is up) adopts its own panel's container, as before; it goes
 * back to the stack when that slot lets go.
 */

type Listener = () => void;

export interface TerminalPoolSnapshot {
  /** Keys (tabHash) activated at least once — the panels the pool keeps alive. */
  readonly mounted: ReadonlySet<string>;
  /** Keys a slot is showing right now. */
  readonly shown: ReadonlySet<string>;
}

interface SlotEntry {
  key: string;
  host: HTMLElement;
}

class TerminalPoolStore {
  private listeners = new Set<Listener>();
  private containers = new Map<string, HTMLDivElement>();
  private slots = new Map<symbol, SlotEntry>();
  /** Slots in the order they last showed; the stack follows the newest. */
  private recency: symbol[] = [];
  private parking: HTMLElement | null = null;
  private stackEl: HTMLDivElement | null = null;
  private scrolled = new Map<Element, { top: number; left: number }>();
  private settlePending = false;
  private snapshot: TerminalPoolSnapshot = { mounted: new Set(), shown: new Set() };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TerminalPoolSnapshot => this.snapshot;

  /** True once `key` has been shown — a return to it is a warm switch. */
  has(key: string): boolean {
    return this.containers.has(key);
  }

  /** The element every container lives in (created on first ask). */
  stack(): HTMLDivElement {
    if (!this.stackEl) {
      const el = document.createElement('div');
      el.dataset.testid = 'terminal-pool-stack';
      el.style.position = 'absolute';
      el.style.inset = '0';
      el.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
      this.stackEl = el;
      this.parking?.appendChild(el);
    }
    return this.stackEl;
  }

  /** The container the pool renders `key`'s panel into (created on first ask). */
  container(key: string): HTMLDivElement {
    let el = this.containers.get(key);
    if (!el) {
      el = document.createElement('div');
      el.dataset.terminalKey = key;
      el.style.position = 'absolute';
      el.style.inset = '0';
      this.containers.set(key, el);
      this.stack().appendChild(el);
    }
    return el;
  }

  /** A slot shows `key` inside `host`: the key becomes (and stays) mounted. */
  show(slot: symbol, key: string, host: HTMLElement): void {
    this.slots.set(slot, { key, host });
    this.recency = [...this.recency.filter((s) => s !== slot), slot];
    this.container(key);
    this.place();
    this.publish();
  }

  /**
   * The slot stops showing its key. Where the stack goes is settled after the
   * current commit: a tab switch unmounts and remounts the SAME slot (hide, then
   * show) in one commit, and parking in between would move the whole stack out
   * and straight back — the very reflow this design exists to avoid.
   */
  hide(slot: symbol): void {
    if (!this.slots.delete(slot)) return;
    this.recency = this.recency.filter((s) => s !== slot);
    this.publish();
    if (this.settlePending) return;
    this.settlePending = true;
    queueMicrotask(() => {
      this.settlePending = false;
      this.place();
    });
  }

  /** Keep only the keys whose tab still exists; a closed tab's runtime goes. */
  retain(liveKeys: ReadonlySet<string>): void {
    for (const [key, el] of this.containers) {
      if (liveKeys.has(key)) continue;
      el.remove();
      this.containers.delete(key);
    }
    this.publish();
  }

  setParking(el: HTMLElement | null): void {
    this.parking = el;
    if (el) this.place();
  }

  resetForTests(): void {
    this.stackEl?.remove();
    this.stackEl = null;
    this.containers.clear();
    this.slots.clear();
    this.recency = [];
    this.scrolled.clear();
    this.parking = null;
    this.snapshot = { mounted: new Set(), shown: new Set() };
    this.emit();
  }

  /**
   * Put the stack in the newest slot's host (or the parking), and every
   * container where it belongs: in the stack, unless a second slot shows it.
   */
  private place(): void {
    const stack = this.stack();
    const owner = this.recency.length ? this.slots.get(this.recency[this.recency.length - 1]) : undefined;
    const home = owner?.host ?? this.parking;
    if (home && stack.parentElement !== home) {
      home.appendChild(stack);
      if (owner) this.restoreScroll();
    }
    const elsewhere = new Map<string, HTMLElement>();
    for (const entry of this.slots.values()) {
      if (entry.host !== stack.parentElement && entry.key !== owner?.key) elsewhere.set(entry.key, entry.host);
    }
    for (const [key, el] of this.containers) {
      const target = elsewhere.get(key) ?? stack;
      if (el.parentElement !== target) target.appendChild(el);
    }
  }

  private onScroll = (e: Event): void => {
    const el = e.target;
    if (el instanceof Element) this.scrolled.set(el, { top: el.scrollTop, left: el.scrollLeft });
  };

  /** A moved node comes back scrolled to 0: put every recorded offset back. */
  private restoreScroll(): void {
    const stack = this.stackEl;
    if (!stack) return;
    for (const [el, at] of this.scrolled) {
      if (!stack.contains(el)) {
        if (!el.isConnected) this.scrolled.delete(el);
        continue;
      }
      if (el.scrollTop !== at.top) el.scrollTop = at.top;
      if (el.scrollLeft !== at.left) el.scrollLeft = at.left;
    }
  }

  /** `mounted` is exactly the keys the pool holds a container for. */
  private publish(): void {
    const mounted = new Set(this.containers.keys());
    const shown = new Set([...this.slots.values()].map((s) => s.key));
    if (sameSet(mounted, this.snapshot.mounted) && sameSet(shown, this.snapshot.shown)) return;
    this.snapshot = { mounted, shown };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export const terminalPool = new TerminalPoolStore();
