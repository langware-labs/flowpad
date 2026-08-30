/**
 * Flowpad app starter.
 *
 * The three rules (see README.md):
 *   1. import the SDK from /sdk/flowpad-sdk.js — never bundle it, never write a
 *      backend URL. This page is served by Flowpad from its own origin.
 *   2. await initSdk() once, before any entity call.
 *   3. use entities (sdk.Task), not fetch — that is what makes writes real and
 *      updates live.
 */
import * as sdk from '/sdk/flowpad-sdk.js';

const statusEl = document.getElementById('status');
const mainEl = document.getElementById('main');
const itemsEl = document.getElementById('items');
const emptyEl = document.getElementById('empty');
const formEl = document.getElementById('create-form');
const titleEl = document.getElementById('new-title');

/** Latest rows from the watched query. Rendering reads ONLY this. */
let tasks = [];

/**
 * The project this app belongs to, as a PROMISE. Only writes need it, so it is
 * started at boot and awaited at the point of use — keeping its round-trip off
 * the path to first paint.
 */
let projectTypeIdPromise = null;

/**
 * Resolve the project that owns this app.
 *
 * Load-bearing: `save()` with no scope places the entity outside any project
 * (`~/agentic-assets/…`), where the user's project task list will never show
 * it. The app is served at `/api/v1/graph/micro_app/<id>/view`, and that
 * MicroApp row carries `project_id` — so the app can read its own identity out
 * of its own URL rather than being told, and rather than assuming the SDK's
 * default project (which is the backend's default, not this app's).
 */
/**
 * The project this app belongs to — and, when it is nested inside another asset,
 * what that asset is.
 *
 * Both come from `sdk.resolveAppHost()`, which reads the app's own delivery row
 * out of the page's path: `app` is this webapp, `subject` is the asset that
 * CONTAINS it (null at top level). An editor nested in an asset uses `subject`
 * to know what it edits — see the README.
 */
async function resolveProjectTypeId() {
  try {
    const { app } = await sdk.resolveAppHost();
    if (app?.project_id) return new sdk.TypeId('project', app.project_id);
  } catch (error) {
    // Served some other way (a dev server has no micro_app in its path).
    console.warn('[app] could not resolve owning project, falling back', error);
  }
  return sdk.dataContext.projectTypeId ?? null;
}

function render() {
  emptyEl.hidden = tasks.length > 0;
  itemsEl.replaceChildren(
    ...tasks.map((task) => {
      const li = document.createElement('li');
      li.className = `item status-${task.status ?? 'to_do'}`;

      const done = document.createElement('input');
      done.type = 'checkbox';
      done.checked = task.status === 'done';
      // Write through the entity; the watched query brings the change back.
      // Never patch `tasks` by hand here — that is how a UI drifts from truth.
      done.addEventListener('change', async () => {
        task.status = done.checked ? 'done' : 'to_do';
        await task.save();
      });

      const label = document.createElement('span');
      label.className = 'title';
      label.textContent = task.title || '(untitled)';

      li.append(done, label);
      return li;
    }),
  );
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = titleEl.value.trim();
  if (!title) return;
  titleEl.value = '';
  // ALWAYS pass the project scope. Without it the task is placed outside the
  // project and never appears in the user's task list.
  await new sdk.Task({ title }).save(await projectTypeIdPromise);
});

async function main() {
  // Adopt the host's light/dark theme from ?theme= before anything paints — a
  // cross-origin page cannot read the class Flowpad sets on its own <html>, so
  // without this a dark window shows a white app.
  sdk.applyHostTheme();
  // Loads the type registry + current project/compute node. Entity calls
  // before this resolves will fail.
  await sdk.initSdk();
  // Started, deliberately not awaited: the list below can paint without it.
  projectTypeIdPromise = resolveProjectTypeId();

  // A watched query is the live channel: the callback fires whenever anything
  // changes these rows — this app, the Flowpad UI, another window, an agent.
  // Do not poll.
  const request = new sdk.QueryRequest({
    type: 'task',
    scope: [], // unscoped, matching Flowpad's own task view
    name: 'flowpad-app-tasks',
    callback: (rows) => {
      tasks = rows ?? [];
      render();
    },
  });

  // watchQuery returns an UNSUBSCRIBE function, not rows — the callback above
  // delivers the first page too, so there is nothing to assign here.
  await sdk.dataManager.watchQuery(request);
  statusEl.textContent = 'Live';
  statusEl.classList.add('ok');
  mainEl.hidden = false;
  render();
}

main().catch((error) => {
  statusEl.textContent = `Failed to start: ${error?.message ?? error}`;
  statusEl.classList.add('error');
  console.error('[app] startup failed', error);
});
