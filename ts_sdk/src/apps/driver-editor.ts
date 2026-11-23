/**
 * The editors of the two selectable drivers, as SDK-provided apps: a browser driver's
 * (`mountBrowserEditor`) and a secret manager's (`mountVaultEditor`).
 *
 * Each ships as a webapp asset nested in its driver's folder
 * (`<driver>/agentic-assets/webapp/editor/`), the way a data driver ships its editor; the
 * subject is the app's PARENT asset (`resolveAppHost`). They edit what a person may set on
 * THIS machine — a browser's app, profile and port; a vault's place in its manager — never the
 * shipped manifest, which the next update would replace.
 *
 * One page for the desktop and the hub. What needs a machine (a window to start, a vault's
 * access here) is gated on `isHubOnly()` inside the page.
 */
import { dataManager, type AnyEntity } from '../APIEntity';
import { dataContext } from '../FlowSync/context';
import { asyncSdkInit, initSdk } from '../main';
import { ActionInfo } from '../models/ActionInfo';
import { credentialsService, type ActiveVault, type SecretVault } from '../services/credentials-service';
import { isHubOnly } from '../utils/hub-runtime';
import { appOption, applyHostTheme, errorText, resolveAppHost } from './host';
import { injectStyles } from '../viewers/dom';

const STYLES = `
/* Palette, fonts and the dark theme come from /sdk/flowpad.css, linked by the page. */
body { font: 14px/1.55 var(--font-sans); margin: 0; }
main { max-width: 46rem; margin: 0 auto; padding: 1.25rem 1rem 2rem; display: grid; gap: 1.25rem; }
h1 { font-size: 1.05rem; margin: 0; }
h2 { font-size: 0.75rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
     color: hsl(var(--muted-foreground)); margin: 0 0 0.6rem; }
p { margin: 0.25rem 0 0; color: hsl(var(--muted-foreground)); }
section { border: 1px solid hsl(var(--border)); border-radius: var(--radius); padding: 0.9rem 1rem; }
.row { display: grid; grid-template-columns: 11rem 1fr; gap: 0.75rem; align-items: center; margin-bottom: 0.5rem; }
.row > span { color: hsl(var(--muted-foreground)); }
input, select { font: inherit; color: inherit; background: hsl(var(--background));
  border: 1px solid hsl(var(--input)); border-radius: calc(var(--radius) - 2px); padding: 0.3rem 0.5rem; min-width: 0; }
button { font: inherit; cursor: pointer; border-radius: calc(var(--radius) - 2px); padding: 0.3rem 0.75rem;
  border: 1px solid hsl(var(--border)); background: hsl(var(--background)); color: inherit; }
button.primary { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); border-color: transparent; }
button:disabled { opacity: 0.55; cursor: default; }
.actions { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.75rem; flex-wrap: wrap; }
table { width: 100%; border-collapse: collapse; }
td { padding: 0.35rem 0.5rem 0.35rem 0; border-top: 1px solid hsl(var(--border)); vertical-align: top; }
tr:first-child td { border-top: 0; }
.state { font-family: var(--font-mono); font-size: 0.8rem; white-space: nowrap; }
.state[data-tone="ok"] { color: hsl(142 60% 36%); }
.state[data-tone="warn"] { color: hsl(35 90% 40%); }
.state[data-tone="muted"] { color: hsl(var(--muted-foreground)); }
.dark .state[data-tone="ok"] { color: hsl(142 60% 60%); }
.dark .state[data-tone="warn"] { color: hsl(40 90% 62%); }
pre { margin: 0; white-space: pre-wrap; font: 0.8rem/1.5 var(--font-mono); }
/* An error is a tinted row with a red border; its text stays the foreground colour. */
.said { margin-top: 0.6rem; padding: 0.4rem 0.6rem; border-radius: calc(var(--radius) - 2px); }
.said:empty { display: none; }
.said.err { border: 1px solid hsl(0 70% 50%); background: hsl(0 70% 50% / 0.1); }
.said.ok { color: hsl(var(--muted-foreground)); }
.vault { border-top: 1px solid hsl(var(--border)); padding-top: 0.75rem; margin-top: 0.75rem; }
.vault:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
.vault h3 { font-size: 0.9rem; margin: 0 0 0.5rem; display: flex; gap: 0.5rem; align-items: baseline; }
`;

const TONES: Record<string, string> = {
  running: 'ok', ready: 'ok', connected: 'ok', open: 'ok',
  not_connected: 'warn', sealed: 'warn',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { text?: string; className?: string; testId?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.text !== undefined) node.textContent = props.text;
  if (props.className) node.className = props.className;
  if (props.testId) node.dataset.testid = props.testId;
  node.append(...children);
  return node;
}

function stateChip(word: string): HTMLElement {
  const chip = el('span', { text: word.replace(/_/g, ' '), className: 'state' });
  chip.dataset.tone = TONES[word] ?? 'muted';
  chip.dataset.state = word;
  return chip;
}

/** `type="button"` always: these sit beside forms, and a default submit would reload the page. */
function button(label: string, onClick: () => unknown, opts: { primary?: boolean; testId?: string } = {}): HTMLButtonElement {
  const node = el('button', { text: label, className: opts.primary ? 'primary' : '', testId: opts.testId });
  node.type = 'button';
  node.addEventListener('click', () => void onClick());
  return node;
}

function field(label: string, control: HTMLElement): HTMLElement {
  return el('label', { className: 'row' }, el('span', { text: label }), control);
}

function say(node: HTMLElement, text: string, error = false): void {
  node.textContent = text;
  node.className = `said ${error ? 'err' : 'ok'}`;
}

/** Shared start: theme, styles, SDK, and the asset this app is nested in. */
async function boot(root: HTMLElement, type: string): Promise<{ main: HTMLElement; subject: AnyEntity }> {
  applyHostTheme();
  injectStyles('flowpad-driver-editor', STYLES);
  const main = el('main');
  root.replaceChildren(main);
  await initSdk({ setupWorkspace: false });
  const { subject } = await resolveAppHost();
  if (!subject || (subject as any).type !== type) throw new Error(`this editor edits a ${type}; it is not nested in one`);
  // The optional half of the SDK start (the current project among it): the vault editor reads it.
  await asyncSdkInit();
  return { main, subject };
}

function fail(root: HTMLElement, error: unknown): never {
  const note = el('div', { testId: 'driver-editor-error' });
  say(note, errorText(error), true);
  root.append(note);
  throw error;
}

// ── browser driver ─────────────────────────────────────────────────────────

interface BrowserView {
  config: Record<string, string>;
  apps: { id: string; name: string; installed: boolean }[];
  workers: { worker: string; label: string; state: string; setup: string }[];
  instructions: string;
}

/** Render a browser driver's editor into `root` and connect it. */
export async function mountBrowserEditor(root: HTMLElement = document.body): Promise<void> {
  try {
    const { main, subject } = await boot(root, 'browser_driver');
    const driver = subject as any;
    const call = <R>(action: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<R> => {
      const info = new ActionInfo(action, driver.type, driver.id, method);
      if (body) info.bodyParameters = body;
      return dataManager.callAction<undefined, R>(info);
    };
    const said = el('div', { className: 'said', testId: 'browser-editor-said' });

    const render = (view: BrowserView) => {
      const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
      const form = el('section', { testId: 'browser-editor-config' }, el('h2', { text: 'On this computer' }));
      for (const spec of (driver.config_fields ?? []) as { name: string; label: string }[]) {
        let control: HTMLInputElement | HTMLSelectElement;
        if (spec.name === 'app') {
          control = el('select');
          control.append(new Option('Automatic — the first one installed', ''));
          for (const app of view.apps) {
            const option = new Option(app.installed ? app.name : `${app.name} — not installed`, app.id);
            option.disabled = !app.installed;
            control.append(option);
          }
        } else {
          control = el('input');
          control.inputMode = spec.name === 'port' ? 'numeric' : 'text';
        }
        control.value = view.config[spec.name] ?? '';
        control.dataset.testid = `browser-editor-field-${spec.name}`;
        inputs.set(spec.name, control);
        form.append(field(spec.label || spec.name, control));
      }
      if (!inputs.size) form.append(el('p', { text: 'This browser has nothing to set here: it belongs to the worker.' }));
      const act = async (work: () => Promise<BrowserView>, done: string) => {
        try {
          render(await work());
          say(said, done);
        } catch (error) {
          say(said, errorText(error), true);
        }
      };
      const actions = el('div', { className: 'actions' });
      if (inputs.size) {
        actions.append(
          button('Save', () => act(() => call<BrowserView>('config', 'POST', { config: Object.fromEntries([...inputs].map(([k, v]) => [k, v.value])) }), 'Saved. A session uses it at its next browser call.'), { primary: true, testId: 'browser-editor-save' }),
        );
      }
      // A window is this machine's: the hub has none to start.
      if (driver.managed && !isHubOnly()) {
        actions.append(
          button('Open window', () => act(() => call<BrowserView>('window', 'POST', { change: 'open' }), 'Window open.'), { testId: 'browser-editor-open' }),
          button('Close window', () => act(() => call<BrowserView>('window', 'POST', { change: 'close' }), 'Window closed.'), { testId: 'browser-editor-close' }),
        );
      }
      form.append(actions, said);

      const table = el('table', { testId: 'browser-editor-workers' });
      for (const row of view.workers) {
        const tr = el('tr', {}, el('td', { text: row.label }), el('td', {}, stateChip(row.state)), el('td', { text: row.setup || (row.state === 'unsupported' ? 'This worker cannot use this browser.' : '') }));
        tr.dataset.worker = row.worker;
        table.append(tr);
      }
      main.replaceChildren(
        el('header', {}, el('h1', { text: driver.title || driver.name }), el('p', { text: driver.description ?? '' })),
        form,
        el('section', {}, el('h2', { text: 'Workers' }), table),
        el('section', {}, el('h2', { text: 'What a session is told' }), el('pre', { text: view.instructions, testId: 'browser-editor-instructions' })),
      );
    };
    render(await call<BrowserView>('describe', 'GET'));
  } catch (error) {
    fail(root, error);
  }
}

// ── secret manager ─────────────────────────────────────────────────────────

/** Render a secret manager's editor into `root`: its vaults in this project and on this instance. */
export async function mountVaultEditor(root: HTMLElement = document.body): Promise<void> {
  try {
    const { main, subject } = await boot(root, 'secret_manager');
    const manager = subject as any;
    const fields = (manager.config_fields ?? []) as { name: string; label: string; required: boolean }[];
    // The dock may name the project (`?project=<id>`), else the SDK's current one, else the project
    // this instance was last used in — the one a CLI command outside any project scopes to.
    const lastActive = async (): Promise<string> => {
      const info = new ActionInfo('last-active', 'project', null, 'GET');
      return (await dataManager.callAction<undefined, { project_id?: string | null }>(info))?.project_id ?? '';
    };
    const projectId =
      appOption('project') || (dataContext.projectTypeId ? String(dataContext.projectTypeId.id) : '') || (await lastActive().catch(() => ''));
    const said = el('div', { className: 'said', testId: 'vault-editor-said' });

    const form = (name: string, config: Record<string, unknown>, save: (name: string, vault: SecretVault) => Promise<unknown>, named: boolean) => {
      const inputs = new Map<string, HTMLInputElement>();
      const box = el('div');
      const nameInput = el('input');
      if (named) box.append(field('Vault name in this project', nameInput));
      for (const spec of fields) {
        const input = el('input');
        input.value = String(config[spec.name] ?? '');
        input.required = spec.required;
        input.dataset.testid = `vault-editor-${name || 'new'}-${spec.name}`;
        inputs.set(spec.name, input);
        box.append(field(spec.label || spec.name, input));
      }
      box.append(
        el('div', { className: 'actions' },
          button(named ? 'Add vault' : 'Save', async () => {
            const target = named ? nameInput.value.trim() : name;
            const missing = fields.find((spec) => spec.required && !inputs.get(spec.name)!.value.trim());
            if (named && !target) return say(said, 'A vault needs a name.', true);
            if (missing) return say(said, `${missing.label || missing.name} is required.`, true);
            try {
              await save(target, { manager: manager.name, config: Object.fromEntries([...inputs].map(([k, v]) => [k, v.value.trim()])) });
              await render();
              say(said, 'Saved. Only the place is saved, never a value.');
            } catch (error) {
              say(said, errorText(error), true);
            }
          }, { primary: true, testId: `vault-editor-save-${name || 'new'}` }),
        ),
      );
      return box;
    };

    const vaultBox = async (row: ActiveVault, save: (name: string, vault: SecretVault) => Promise<unknown>, title: string) => {
      const heading = el('h3', {}, title);
      // Access is this machine's; asked without ever prompting the person.
      if (!isHubOnly() && projectId) {
        try {
          heading.append(stateChip((await credentialsService.vaultAccess(projectId, row)).state));
        } catch {
          heading.append(stateChip('unknown'));
        }
      }
      return el('div', { className: 'vault', testId: `vault-editor-vault-${row.name}` }, heading, form(row.name, row.vault.config, save, false));
    };

    const render = async () => {
      const mine = el('section', { testId: 'vault-editor-project' }, el('h2', { text: 'In this project' }));
      const shared = el('section', { testId: 'vault-editor-global' }, el('h2', { text: 'On this instance' }));
      let instructions = '';
      if (projectId) {
        const [listed, active] = await Promise.all([credentialsService.vaultList(projectId), credentialsService.activeVault(projectId)]);
        const own = listed.rows.filter((r) => r.vault.manager === manager.name);
        mine.append(
          ...(await Promise.all(own.map((row) => vaultBox(row, (name, vault) => credentialsService.addVault(projectId, name, vault), row.is_default ? `${row.name} · default` : row.name)))),
        );
        if (mine.childElementCount === 1) mine.append(el('p', { text: 'No vault of this manager yet.' }));
        mine.append(el('div', { className: 'vault' }, el('h3', {}, 'New vault'), form('', {}, (name, vault) => credentialsService.addVault(projectId, name, vault), true)));
        const global = listed.global?.vault.manager === manager.name ? listed.global : null;
        if (global) shared.append(await vaultBox(global, (_name, vault) => credentialsService.setGlobalVault(vault), 'Global'));
        else shared.append(el('p', { text: 'This instance uses no vault of this manager.' }));
        if (active.active?.vault.manager === manager.name) instructions = active.instructions;
      } else {
        mine.append(el('p', { text: 'Open this editor from a project to see its vaults.' }));
      }
      main.replaceChildren(
        el('header', {}, el('h1', { text: manager.title || manager.name }), el('p', { text: manager.description ?? '' })),
        mine,
        shared,
        el('section', {}, el('h2', { text: 'What a session is told' }),
          el('pre', { text: instructions || 'Shown when one of this manager\'s vaults is the one in use for the project.', testId: 'vault-editor-instructions' })),
        said,
      );
    };
    await render();
  } catch (error) {
    fail(root, error);
  }
}
