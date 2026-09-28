/**
 * The terminal pool — a runtime (xterm + PTY attach) lives as long as its TAB,
 * not as long as the layout that happens to show it (docs/navigation/dock-loading.md, I6).
 *
 * Every terminal panel is rendered ONCE, by `<TerminalPool/>` (mounted above every
 * layout in RootLayout), through a React portal into a container `div` the pool
 * owns. A body that shows a terminal — `TabbedTerminal`, in whichever layout the
 * URL picked — is only a SLOT: it adopts the container for the key it shows by
 * `appendChild`, and gives it back on unmount. A layout swap therefore moves a
 * DOM node; it never unmounts the React subtree, so nothing re-opens, re-streams
 * or replays.
 *
 * Containers nobody shows are parked in the pool's hidden parking element, still
 * in the document (xterm keeps its geometry; inactive panels never fit/resize).
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
  private parking: HTMLElement | null = null;
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

  /** The container the pool renders `key`'s panel into (created on first ask). */
  container(key: string): HTMLDivElement {
    let el = this.containers.get(key);
    if (!el) {
      el = document.createElement('div');
      el.dataset.terminalKey = key;
      el.style.position = 'absolute';
      el.style.inset = '0';
      this.containers.set(key, el);
      this.parking?.appendChild(el);
    }
    return el;
  }

  /** A slot shows `key` inside `host`: the key becomes (and stays) mounted. */
  show(slot: symbol, key: string, host: HTMLElement): void {
    this.slots.set(slot, { key, host });
    const el = this.container(key);
    if (el.parentElement !== host) host.appendChild(el);
    this.publish();
  }

  /** The slot stops showing its key; the container is parked unless another slot shows it. */
  hide(slot: symbol): void {
    const entry = this.slots.get(slot);
    if (!entry) return;
    this.slots.delete(slot);
    const el = this.containers.get(entry.key);
    const stillShown = [...this.slots.values()].find((s) => s.key === entry.key);
    if (el && stillShown) {
      if (el.parentElement !== stillShown.host) stillShown.host.appendChild(el);
    } else if (el && el.parentElement === entry.host) {
      this.park(el);
    }
    this.publish();
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
    if (!el) return;
    const shownKeys = new Set([...this.slots.values()].map((s) => s.key));
    for (const [key, container] of this.containers) {
      if (!shownKeys.has(key) && container.parentElement !== el) el.appendChild(container);
    }
  }

  resetForTests(): void {
    for (const el of this.containers.values()) el.remove();
    this.containers.clear();
    this.slots.clear();
    this.parking = null;
    this.snapshot = { mounted: new Set(), shown: new Set() };
    this.emit();
  }

  private park(el: HTMLDivElement): void {
    if (this.parking) this.parking.appendChild(el);
    else el.remove();
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
