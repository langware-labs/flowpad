/**
 * What every app opened on a dataset shares: the dataset itself, and labelling one example.
 *
 * Labelling is ONE path for every app (the dataset editor, the eval browser): the dataset kind's own
 * viewer in edit mode — so whatever a dataset shows beside its form (the run's answer, say) shows
 * everywhere — and what it reads back is written through `annotate`.
 */
import { initSdk } from '../main';
import { Dataset } from '../entities/dataset';
import type { ViewerContext } from '../viewers/contract';
import { h } from '../viewers/dom';
import { errorText, resolveAppHost } from './host';

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
