/**
 * Runs a script the backend sent to this tab (`ui_command` kind `run_script`) and answers it.
 *
 * It is how a live session's "Flowpad control" turn runs: the host approved that kind for the
 * session, the host's backend picked this tab, and the script gets the SDK as `sdk`
 * (`sdk.dataManager`, `sdk.ActionInfo`, the entity classes). It acts as the signed-in user.
 * What it returns must be plain JSON; a throw is an answer too, not a crash.
 */
export type TabScriptAnswer = { ok: true; value: unknown } | { ok: false; error: string };

// eslint-disable-next-line @typescript-eslint/no-empty-function
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (sdk: unknown) => Promise<unknown>;

export async function runTabScript(code: string): Promise<TabScriptAnswer> {
  try {
    const value = await new AsyncFunction('sdk', code)(await import('@sdk'));
    // Through JSON on purpose: an entity, a Map or a cycle must fail here, as an answer.
    return { ok: true, value: JSON.parse(JSON.stringify(value ?? null)) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}
