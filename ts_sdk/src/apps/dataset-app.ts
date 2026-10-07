/**
 * What every app opened on a dataset shares: the dataset itself, and labelling one example.
 *
 * Labelling is ONE path for every app (the dataset editor, the eval browser): the dataset kind's own
 * viewer in edit mode — so whatever a dataset shows beside its form (the run's answer, say) shows
 * everywhere — and what it reads back is written through `annotate`.
 */
import { initSdk } from '../main';
import { Dataset } from '../entities/dataset';
import type { OpenRequest, ViewerContext } from '../viewers/contract';
import { h, injectStyles } from '../viewers/dom';
import { createViewerContext } from '../viewers/registry';
import { errorText, navigateHost, resolveAppHost } from './host';

const FOCUS_STYLES = `
.vf-overlay { position: fixed; inset: 0; z-index: 50; background: hsl(var(--background)); overflow: auto; }
.vf-head { position: sticky; top: 0; display: flex; gap: .4rem; align-items: center; flex-wrap: wrap; padding: .7rem 1.25rem; border-bottom: 1px solid hsl(var(--border)); background: hsl(var(--background)); font-size: 13px; z-index: 1; }
.vf-head button { font: inherit; background: none; border: 0; padding: 0; color: hsl(var(--primary)); cursor: pointer; }
.vf-head .vf-sep { color: hsl(var(--muted-foreground)); }
.vf-head .vf-close { margin-left: auto; border: 1px solid hsl(var(--border)); border-radius: 6px; padding: .2rem .6rem; color: inherit; }
.vf-body { padding: 1rem 1.25rem 3rem; max-width: 1100px; }
`;

/**
 * The viewer context an app on a dataset uses: viewers nested in the dataset win (`within`), a part a
 * viewer opens (`ctx.open`) shows on its own in a panel with a trail back — each step a history
 * entry, so Back closes it — and an entity a viewer opens (`ctx.navigate`) is opened by the host.
 */
export function datasetViewerContext(subject: string, rootTitle = 'Example'): ViewerContext {
  injectStyles('viewer-focus', FOCUS_STYLES);
  const overlay = h('div', { class: 'vf-overlay' });
  overlay.hidden = true;
  document.body.append(overlay);
  // The parts opened live here; history holds only their ids (a part can be a whole decision).
  const parts = new Map<number, OpenRequest>();
  let next = 0;
  const stackOf = (): OpenRequest[] =>
    ((history.state?.focus as number[] | undefined) ?? []).map((id) => parts.get(id)).filter(Boolean) as OpenRequest[];

  async function show(stack: OpenRequest[]) {
    overlay.hidden = !stack.length;
    if (!stack.length) return void overlay.replaceChildren();
    const top = stack[stack.length - 1];
    const head = h('div', { class: 'vf-head' }, h('button', { onclick: () => history.go(-stack.length) }, rootTitle));
    stack.forEach((part, i) => {
      head.append(h('span', { class: 'vf-sep' }, '›'));
      head.append(i === stack.length - 1 ? h('b', {}, part.title) : h('button', { onclick: () => history.go(i + 1 - stack.length) }, part.title));
    });
    head.append(h('button', { class: 'vf-close', onclick: () => history.go(-stack.length) }, 'Close'));
    const body = h('div', { class: 'vf-body' });
    overlay.replaceChildren(head, body);
    overlay.scrollTop = 0;
    await ctx.render(body, { kind: top.kind, value: top.value, meta: top.meta });
  }

  const ctx = createViewerContext({
    within: subject,
    open: (part) => {
      parts.set(++next, part);
      history.pushState({ ...(history.state ?? {}), focus: [...((history.state?.focus as number[]) ?? []), next] }, '');
      void show(stackOf());
    },
    navigate: (typeid) => navigateHost({ typeid }),
  });
  window.addEventListener('popstate', () => void show(stackOf()));
  return ctx;
}

/** Where an app draws: the element it is given, else its own element on the page -- never the page
 *  itself, which an app redraws wholesale and other parts (a focus panel) share. */
export function appRoot(root?: HTMLElement): HTMLElement {
  return root ?? document.body.appendChild(document.createElement('div'));
}

/** The dataset this app is opened on (`?subject=dataset-<id>`, or the dataset it is nested in). */
export async function hostDataset(): Promise<any> {
  await initSdk({ setupWorkspace: false });
  const found: any = (await resolveAppHost()).subject;
  if (!found || found.type !== 'dataset') throw new Error('this app needs a dataset (?subject=dataset-<id>)');
  // The lookup answers a plain row; the actions (rows, annotate, evals) live on the class.
  return found instanceof Dataset ? found : new Dataset(found);
}

export interface LabelOptions {
  ctx: ViewerContext;
  dataset: any;
  /** The dataset's declared kind — its viewer draws the form. */
  kind: string;
  /** The example as a row; `output` is what a run answered (offered as a starting point). */
  row: Record<string, any>;
  onSaved?: (groundTruth: unknown) => void;
  onCancel?: () => void;
}

/** The example in edit mode, with Save (and "start from what the run answered" when there is one). */
export async function mountLabel(el: HTMLElement, options: LabelOptions, start?: unknown): Promise<void> {
  const { ctx, dataset, kind, row } = options;
  const body = h('div');
  const status = h('span', { class: 'small' });
  const save = h('button', { class: 'primary', 'data-testid': 'dataset-editor-save' }, 'Save the right answer');
  el.replaceChildren(body, h('div', { class: 'bar' }, save,
    row.output != null ? h('button', { onclick: () => void mountLabel(el, options, row.output) }, 'Start from what the run answered') : null,
    options.onCancel ? h('button', { onclick: options.onCancel }, 'Cancel') : null,
    status));
  const mounted = await ctx.render(body, { kind, value: start === undefined ? row : { ...row, ground_truth: start }, mode: 'edit' });
  save.addEventListener('click', async () => {
    try {
      const value = mounted.read?.();
      await dataset.annotate(row.id, value);
      status.textContent = 'saved';
      status.className = 'small ok';
      options.onSaved?.(value);
    } catch (error) {
      status.textContent = errorText(error);
      status.className = 'small err';
    }
  });
}
