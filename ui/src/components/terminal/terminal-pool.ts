import type { AppDisplayViewerProps } from '@src/pages/flow-page/app-display-viewer';

/**
 * The terminal pool — a runtime (xterm + PTY attach) lives as long as its TAB,
 * not as long as the layout that happens to show it (docs/navigation/dock-loading.md, I6).
 * The one narrowing: a panel nobody is looking at whose agent has ENDED is given back
 * (`release`) while its tab stays open; the tab's next visit mounts it cold.
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

export interface RuntimePoolSnapshot<P = undefined> {
  /** Keys the pool holds a runtime for: shown at least once and not given back since. */
  readonly mounted: ReadonlySet<string>;
  /** Keys a slot is showing right now. */
  readonly shown: ReadonlySet<string>;
  /** The props each mounted key was last shown with (`show`'s last argument). */
  readonly props: ReadonlyMap<string, P>;
}

export type TerminalPoolSnapshot = RuntimePoolSnapshot<undefined>;

export interface RuntimePoolOptions {
  /** `data-testid` of the stack element. */
  stackTestId: string;
  /** `dataset` field each container carries its key in (`terminalKey` → `data-terminal-key`). */
  keyAttr: string;
  /**
   * Hide (`display: none`) every container no slot shows. A terminal panel hides itself; a view
   * whose content is drawn OUTSIDE its container (an app's frame, positioned over its host by the
   * iframe registry) needs the host to measure 0×0 while it is not on screen.
   */
  hideUnshown?: boolean;
}

interface SlotEntry {
  key: string;
  host: HTMLElement;
}

/**
 * A pool of runtimes kept per key for the life of their tab (I6) — the terminal pool's
 * mechanism, generalized: `show(slot, key, host, props)` records the props the key's
 * runtime renders with, so the pool's renderer can draw it without its slot.
 */
export class RuntimePoolStore<P = undefined> {
  constructor(private readonly options: RuntimePoolOptions) {}

  private listeners = new Set<Listener>();
  private props = new Map<string, P>();
  private containers = new Map<string, HTMLDivElement>();
  private slots = new Map<symbol, SlotEntry>();
  /** Slots in the order they last showed; the stack follows the newest. */
  private recency: symbol[] = [];
  private parking: HTMLElement | null = null;
  private stackEl: HTMLDivElement | null = null;
  private scrolled = new Map<Element, { top: number; left: number }>();
  private settlePending = false;
  private snapshot: RuntimePoolSnapshot<P> = { mounted: new Set(), shown: new Set(), props: new Map() };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RuntimePoolSnapshot<P> => this.snapshot;

  /** True while the pool holds `key`'s panel — a return to it is a warm switch. */
  has(key: string): boolean {
    return this.containers.has(key);
  }

  /** The element every container lives in (created on first ask). */
  stack(): HTMLDivElement {
    if (!this.stackEl) {
      const el = document.createElement('div');
      el.dataset.testid = this.options.stackTestId;
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
      el.dataset[this.options.keyAttr] = key;
      el.style.position = 'absolute';
      el.style.inset = '0';
      this.containers.set(key, el);
      this.stack().appendChild(el);
    }
    return el;
  }

  /** A slot shows `key` inside `host`: the key becomes (and stays) mounted. */
  show(slot: symbol, key: string, host: HTMLElement, ...rest: P extends undefined ? [props?: P] : [props: P]): void {
    this.slots.set(slot, { key, host });
    if (rest.length) this.props.set(key, rest[0] as P);
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
    this.drop([...this.containers.keys()].filter((key) => !liveKeys.has(key)));
  }

  /**
   * Give back `key`'s panel while its tab stays open; the next `show` mounts it cold.
   * Refused (false) for a key a slot is showing — the panel on screen never goes.
   */
  release(key: string): boolean {
    for (const entry of this.slots.values()) if (entry.key === key) return false;
    if (!this.containers.has(key)) return false;
    this.drop([key]);
    return true;
  }

  setParking(el: HTMLElement | null): void {
    this.parking = el;
    if (el) this.place();
  }

  resetForTests(): void {
    this.stackEl?.remove();
    this.stackEl = null;
    this.containers.clear();
    this.props.clear();
    this.slots.clear();
    this.recency = [];
    this.scrolled.clear();
    this.parking = null;
    this.snapshot = { mounted: new Set(), shown: new Set(), props: new Map() };
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
    const shown = this.options.hideUnshown ? new Set([...this.slots.values()].map((s) => s.key)) : null;
    for (const [key, el] of this.containers) {
      const target = elsewhere.get(key) ?? stack;
      if (el.parentElement !== target) target.appendChild(el);
      if (shown) el.style.display = shown.has(key) ? '' : 'none';
    }
  }

  /** The one way a panel leaves the pool: its container, and every scroll offset recorded under it. */
  private drop(keys: readonly string[]): void {
    for (const key of keys) {
      this.containers.get(key)?.remove();
      this.containers.delete(key);
      this.props.delete(key);
    }
    if (keys.length) this.forgetDetachedScroll();
    this.publish();
  }

  private onScroll = (e: Event): void => {
    const el = e.target;
    if (el instanceof Element) this.scrolled.set(el, { top: el.scrollTop, left: el.scrollLeft });
  };

  /** A moved node comes back scrolled to 0: put every recorded offset back. */
  private restoreScroll(): void {
    const stack = this.stackEl;
    if (!stack) return;
    this.forgetDetachedScroll();
    for (const [el, at] of this.scrolled) {
      if (!stack.contains(el)) continue;
      if (el.scrollTop !== at.top) el.scrollTop = at.top;
      if (el.scrollLeft !== at.left) el.scrollLeft = at.left;
    }
  }

  /**
   * A scroller that left the stack and the document is never restored: forget its offset, or the
   * element — and the whole removed panel it belongs to — stays reachable from this map. "Left the
   * stack" is part of the test because an unparked stack is itself outside the document.
   */
  private forgetDetachedScroll(): void {
    const stack = this.stackEl;
    for (const el of this.scrolled.keys()) {
      if (!stack?.contains(el) && !el.isConnected) this.scrolled.delete(el);
    }
  }

  /** `mounted` is exactly the keys the pool holds a container for. */
  private publish(): void {
    const mounted = new Set(this.containers.keys());
    const shown = new Set([...this.slots.values()].map((s) => s.key));
    const props = this.snapshot.props;
    const propsSame = props.size === this.props.size && [...this.props].every(([k, v]) => props.get(k) === v);
    if (sameSet(mounted, this.snapshot.mounted) && sameSet(shown, this.snapshot.shown) && propsSame) return;
    this.snapshot = { mounted, shown, props: propsSame ? props : new Map(this.props) };
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

export const terminalPool = new RuntimePoolStore({ stackTestId: 'terminal-pool-stack', keyAttr: 'terminalKey' });

export interface PooledAppProps {
  /** What the pooled `AppDisplayViewer` renders with. */
  viewer: AppDisplayViewerProps;
  /** The tab that showed the view last: the view lives as long as that tab (I6). */
  tabHash: string;
}

/**
 * The app views (`components/app-pool`), kept per `appViewKey` for the life of their tab. Hidden
 * containers are `display: none`: an app's frame is drawn over its host by the iframe registry,
 * so a parked host must measure 0×0 or its frame would still cover the screen.
 */
export const appPool = new RuntimePoolStore<PooledAppProps>({
  stackTestId: 'app-pool-stack',
  keyAttr: 'appKey',
  hideUnshown: true,
});
