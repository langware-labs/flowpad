import { dataManager, QueryRequest, Wizard } from '@sdk';

/** The shipped first-run wizard, by name (`LLM_SETUP_WIZARD` on the backend). */
export const FIRST_RUN_WIZARD = 'llm-setup';

/** The first-run wizard's entity, or `undefined` when this install does not ship it. */
export async function findSetupWizard(): Promise<Wizard | undefined> {
  const [setup] = await dataManager.query<Wizard>(
    new QueryRequest({ type: Wizard.type, query: { name: FIRST_RUN_WIZARD } }),
  );
  return setup;
}

/**
 * First-run setup, again: opens its popup blank. Nothing runs until the person presses the
 * popup's own Start — the same order the first-run trigger keeps — so its install questions never
 * land on top of a popup that has not been read yet.
 *
 * The one door for "run setup again": Settings → General and the footer's setup warning both call
 * it, so they cannot drift apart. Returns `false` when the wizard is not installed.
 */
export async function openSetupWizard(): Promise<boolean> {
  const setup = await findSetupWizard();
  if (!setup) return false;
  await setup.open();
  return true;
}
