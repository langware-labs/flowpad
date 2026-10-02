'use strict';

/**
 * One way to tell the user that something failed: a native dialog with "OK" and "Share with us".
 *
 * Every failure the user can SEE should offer the same way to reach the team, so the logs that explain it do not
 * depend on the user knowing where they live. "Share with us" builds the support bundle and opens the mail client
 * (see support-bundle.js); nothing is sent until the user presses Send.
 *
 * Dependencies are injected so this is unit-testable (main.js is not).
 */

/** Electron accepts (opts) or (window, opts); a missing window must not be passed as `undefined`. */
const show = (dialog, parent, opts) => (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts));

const OK = 0;
const SHARE = 1;

/**
 * @param {object} o
 * @param {{ showMessageBox(parent: any, opts: object): Promise<{response: number}> }} o.dialog
 * @param {any} [o.parent]  window to attach to (undefined → free-standing dialog)
 * @param {'error'|'warning'|'info'} [o.type]
 * @param {string} o.title
 * @param {string} o.message
 * @param {string} [o.detail]
 * @param {((detail: string) => Promise<{ok: boolean, error?: string}>)|null} [o.share]
 *        null/undefined → the dialog has an "OK" button only (nothing to share with).
 * @param {{warn: Function}} [o.log]
 * @returns {Promise<'ok'|'shared'|'share-failed'>}
 */
async function showFailureDialog({ dialog, parent, type = 'error', title, message, detail = '', share = null, log = null }) {
  const buttons = share ? ['OK', 'Share with us'] : ['OK'];
  let response = OK;
  try {
    ({ response } = await show(dialog, parent, {
      type, title, message, detail, buttons, defaultId: OK, cancelId: OK,
    }));
  } catch (err) {
    if (log) log.warn(`[failure-dialog] could not show "${title}": ${err && err.message}`);
    return 'ok';
  }
  if (!share || response !== SHARE) return 'ok';

  // What the user saw is what the team needs to read: the headline plus the detail.
  const text = [message, detail].filter(Boolean).join('\n\n');
  let result;
  try {
    result = await share(text);
  } catch (err) {
    result = { ok: false, error: err && err.message };
  }
  if (result && result.ok) return 'shared';

  if (log) log.warn(`[failure-dialog] share failed: ${result && result.error}`);
  try {
    await show(dialog, parent, {
      type: 'warning',
      title: 'Could not prepare the logs',
      message: 'Flowpad could not prepare the logs to share.',
      detail: `${(result && result.error) || 'Unknown error'}\n\nThe logs are in your .flow folder (logs). You can attach the newest files to an email to diagnosis@langware.ai.`,
      buttons: ['OK'],
      defaultId: OK,
    });
  } catch { /* nothing more to do */ }
  return 'share-failed';
}

module.exports = { showFailureDialog, OK, SHARE };
