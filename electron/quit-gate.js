'use strict';

/*
 * The one door out of the app: every quit — the window's X, Cmd+Q, Alt+F4, the
 * dock's Quit — asks "Are you sure?" first, and only a "Quit" answer lets it
 * through.
 *
 * Before this, the X closed the window at once: `closed` → `window-all-closed`
 * → `app.quit()` → `before-quit`, which is too late to cancel — the window was
 * already gone. A user who closed during startup also stopped the backend
 * while the startup chain kept running, and that chain then launched
 * `flow start` AFTER the stop: a detached monitor and server that outlived the
 * app (see UvManager.close()).
 *
 * The gate only decides; it never quits by itself. The caller asks
 * `request(phase)` and quits when it resolves true. Quits the app makes on its
 * own (the restart into an update, the error panel's Quit button, the OS
 * shutting down) call `allow()` — there is nobody to ask, or the user already
 * answered somewhere else.
 *
 * Dependencies are injected so the state machine is unit-testable (main.js is not).
 */

/** What the dialog says for each phase the app can be in when the user quits. */
function quitDialogOptions(phase, { hasInstallMarker = false } = {}) {
  if (phase === 'installing') {
    return {
      type: 'warning',
      title: 'Update in progress',
      message: 'FlowPad is installing its components.',
      detail: hasInstallMarker
        ? 'Quitting now interrupts it. FlowPad will repair the installation the next time it starts.'
        : 'Quitting now interrupts it and may leave the installation incomplete. If FlowPad does not start next time, reinstall it.',
      buttons: ['Keep waiting', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
    };
  }
  const starting = phase === 'starting';
  return {
    type: 'question',
    title: 'Quit FlowPad',
    message: starting ? 'FlowPad is still starting.' : 'Are you sure you want to quit FlowPad?',
    detail: starting ? 'Quitting now stops the startup.' : undefined,
    buttons: ['Cancel', 'Quit'],
    defaultId: 0,
    cancelId: 0,
  };
}

/** The button index that means "quit" in quitDialogOptions — the same for every phase. */
const QUIT_RESPONSE = 1;

/**
 * @param {object} deps
 * @param {(phase: string) => Promise<boolean>} deps.confirm  show the dialog; true = quit
 * @param {{info: Function, warn: Function}} deps.log
 */
function createQuitGate({ confirm, log }) {
  let confirmed = false;
  let asking = null;

  return {
    /** True once the user (or the app, via allow()) has let the quit through. */
    isConfirmed() {
      return confirmed;
    },

    /** Let the next quit through without asking. */
    allow(why) {
      if (!confirmed) log.info(`[quit] no confirmation needed: ${why}`);
      confirmed = true;
    },

    /** Undo allow() — the quit it was made for did not happen. */
    revoke(why) {
      if (confirmed) log.info(`[quit] confirmation required again: ${why}`);
      confirmed = false;
    },

    /**
     * Ask once. A second X while the dialog is up joins the open question
     * instead of stacking another dialog. Resolves true when the quit may go on.
     */
    request(phase) {
      if (confirmed) return Promise.resolve(true);
      if (asking) return asking;
      asking = Promise.resolve()
        .then(() => confirm(phase))
        .then((yes) => {
          log.info(`[quit] ${phase}: the user chose ${yes ? 'Quit' : 'Cancel'}`);
          if (yes) confirmed = true;
          return !!yes;
        }, (err) => {
          // A dialog that cannot be shown must not trap the user in the app.
          log.warn(`[quit] confirmation dialog failed, quitting: ${err && err.message}`);
          confirmed = true;
          return true;
        })
        .finally(() => {
          asking = null;
        });
      return asking;
    },
  };
}

module.exports = { createQuitGate, quitDialogOptions, QUIT_RESPONSE };
