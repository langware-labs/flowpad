/**
 * A nano-app's start: ONE `.html` file that is a whole app (`flow_sdk/schema/data_spec/nano_app_spec.py`).
 *
 * The file declares up to three slots and the host says which one it wants in `?slot=`:
 *
 *   <template data-slot="header">…</template>   one line of text — filled by the backend, never mounted here
 *   <template data-slot="block">…</template>    inside a message or a section
 *   <main data-slot="page">…</main>             a tab; the default, and what a bare browser shows
 *
 * `const app = await nano.start()` — theme, the slot mounted, the SDK started, the value it was opened
 * on read, and (framed, outside the page slot) its height reported so the host sizes the frame.
 */
import { FSRef } from '../fs/FSRef';
import { initSdk } from '../main';
import { TypeId } from '../models/TypeId';
import { DEFAULT_WIKI_SPACE } from '../utils/wiki-word';
import { readValue } from '../viewers/kinds';
import { appOption, applyHostTheme, hasHost, postToHost } from './host';

export type NanoSlot = 'header' | 'block' | 'page';

/** The app tells the host how tall its content is (`{type, height}`); the host sizes the frame. */
export const NANO_SIZE_MESSAGE = 'flowpad:nano-size';
/** The app asks the host to show it in another slot (`{type, slot}`) — in practice, its page in a tab. */
export const NANO_OPEN_MESSAGE = 'flowpad:nano-open';

export interface NanoApp {
  /** The slot that is mounted: the one asked for, or `page` when the file does not declare it. */
  slot: NanoSlot;
  /** The value the app was opened on (`?input=<a value file>`): its kind and its fields. */
  input: { kind: string; value: Record<string, unknown> } | null;
  /** Ask the host to show another slot of this app. Nothing happens without a host. */
  open(slot: NanoSlot): void;
}

/** Mount the asked-for slot: its template's content takes the place of the template, the others hide. */
function mount(asked: string | null): NanoSlot {
  const template = asked === 'block' ? document.querySelector<HTMLTemplateElement>('template[data-slot="block"]') : null;
  const slot: NanoSlot = template ? 'block' : 'page';
  if (template) {
    const mounted = document.createElement('div');
    mounted.dataset.slotMounted = slot;
    mounted.append(template.content.cloneNode(true));
    template.replaceWith(mounted);
    document.querySelectorAll<HTMLElement>('[data-slot="page"]').forEach((el) => (el.hidden = true));
  }
  document.documentElement.dataset.slot = slot;
  return slot;
}

async function readInput(path: string | null): Promise<NanoApp['input']> {
  if (!path) return null;
  const read = readValue(await new FSRef(path, new TypeId('compute_node', DEFAULT_WIKI_SPACE)).read());
  return { kind: read.kind, value: read.value as Record<string, unknown> };
}

/** Tell the host the content's height now and whenever it changes. */
function reportSize(): void {
  let last = -1;
  const say = () => {
    // The body's own box with its margins, not the document's scroll height: that one never goes below the
    // frame's current height, so a frame that grew (a taller tab) could not shrink again.
    const margins = getComputedStyle(document.body);
    const height = Math.ceil(
      document.body.getBoundingClientRect().height + (parseFloat(margins.marginTop) || 0) + (parseFloat(margins.marginBottom) || 0),
    );
    if (height !== last) postToHost({ type: NANO_SIZE_MESSAGE, height: (last = height) });
  };
  new ResizeObserver(say).observe(document.body);
  say();
}

async function start(): Promise<NanoApp> {
  applyHostTheme();
  const slot = mount(appOption('slot'));
  await initSdk({ setupWorkspace: false });
  const input = await readInput(appOption('input'));
  if (hasHost() && slot !== 'page') reportSize();
  return { slot, input, open: (to) => postToHost({ type: NANO_OPEN_MESSAGE, slot: to }) };
}

export const nano = { start };
