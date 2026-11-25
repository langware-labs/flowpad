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
 *
 * The STATE KEY is the one thing an opener hands the file (`?state=<key>`): it names what the app was opened
 * on (a message), and the value and what the app saved come from the backend through it. So the same file
 * opens in a message, in a tab, and as a `file://` in a browser — there with `&api=<backend origin>` so it
 * can load this SDK: `await import((new URLSearchParams(location.search).get('api') ?? '') + '/sdk/flowpad-sdk.js')`.
 */
import { sdkConfig } from '../config/index';
import { FlowMessage } from '../entities/flow-message';
import { initSdk } from '../main';
import { showPageStateError, stateKey } from '../page-state';
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
  /** The value the app was opened on — the one the message its state key names carries for it: its kind
   *  and its fields. Null when the key names no message. */
  input: { kind: string; value: Record<string, unknown> } | null;
  /** What the app saved on an earlier visit (`save`), or null. */
  saved: unknown;
  /** Keep `data` (plain JSON) for the next visit, in any slot. */
  save(data: unknown): Promise<void>;
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

/** A page the backend does not serve (a file in a browser): it has no `/sdk/flowpad.css`, so the backend's is
 *  linked; and with no key in its address it can ask the backend nothing — said in the page, not left blank. */
function asBareFile(): void {
  if (sdkConfig.apiUrl === location.origin) return;
  const sheet = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${sdkConfig.apiUrl}/sdk/flowpad.css` });
  document.head.prepend(sheet);
  if (!stateKey()) {
    showPageStateError('missing');
    throw new Error('This page was opened without a state key.');
  }
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
  asBareFile();
  await initSdk({ setupWorkspace: false });
  const data = await FlowMessage.appData();
  const read = data.input ? readValue(data.input) : null;
  if (hasHost() && slot !== 'page') reportSize();
  return {
    slot,
    input: read && { kind: read.kind, value: read.value as Record<string, unknown> },
    saved: data.saved,
    save: (saved) => FlowMessage.saveAppData(saved),
    open: (to) => postToHost({ type: NANO_OPEN_MESSAGE, slot: to }),
  };
}

export const nano = { start };
