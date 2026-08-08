import { JourneyGraph, registerMemoryJourney, type JourneyStep, type JourneyWaitCondition } from '@sdk';

/**
 * VIBE EXIT #1 — the footer mode switch.
 *
 * A probe journey: it exists to make one way OUT of the Vibe workspace visible
 * by having you take it. We are reviewing every exit case by case and deciding
 * which should stay, so these read as demonstrations, not onboarding.
 *
 * The shape every probe in this campaign follows: **get into a real workspace
 * first, then leave it.** Pointing at the exit control from an empty home proves
 * nothing — there is nothing on screen to lose. The loss is the point, so the
 * journey opens a live build (chat pane, display, its own tab strip), makes you
 * look at it, and only then takes the exit.
 *
 * The exit under review: `ViewToggle` (`components/view-toggle/view-toggle.tsx`)
 * renders Vibe / Chat / Terminal side by side and always offers all three — its
 * own comment says "this is the mode selector, not a power-user ladder". So a
 * non-technical user is one unlabelled click from losing the workspace, with no
 * confirmation and nothing naming what went.
 *
 * Written in code rather than as a `graph.json` folder because a probe is
 * rewritten as fast as we can look at it — see `MemoryJourney`.
 */

/** A read-and-Continue step: the tray's button is the only way forward. */
function step(node_id: string, name: string, status_line: string, over: Partial<JourneyStep> = {}): JourneyStep {
  return { node_id, name, status_line, present: {}, waitFor: [{ manual: true }], ...over };
}

/**
 * A step that takes a real exit: it completes when the app HAS changed, not when
 * a button was pressed.
 *
 * Deliberately waits on state ALONE, with no click condition, for two reasons.
 * The obvious one: waiting on the click advanced ~100ms before the navigation
 * settled, so the step narrated a loss that had not happened yet. The subtler
 * one: an occurrence can only be seen from the moment the runtime subscribes,
 * so a click landing in the same frame as the previous step's advance is missed
 * — which a fast driver hits and a person does not. State has neither problem:
 * it is re-read whenever it changes AND checked the moment the step arrives.
 *
 * It also reads better. The highlight already says which control to press; the
 * condition should say what must become true, and it does not care whether the
 * user got there by the button, a shortcut, or the back button.
 */
function exitStep(
  node_id: string,
  name: string,
  status_line: string,
  tag: string,
  becomes: JourneyWaitCondition,
): JourneyStep {
  return step(node_id, name, status_line, {
    present: { highlight: tag },
    waitFor: [becomes],
  });
}

export const VIBE_EXIT_MODE_SWITCH = new JourneyGraph({
  start: { kind: 'root' },
  steps: [
    // ── in ──
    // Click-only, and honestly so: at the app root the view mode is a stored
    // PREFERENCE, not a URL option (the root deliberately does not carry
    // `?viewMode=`), so there is no state here to wait on. A preparatory step,
    // not a claim about a consequence.
    step(
      'enter_vibe',
      'Start in Vibe',
      'Click the wand in the footer. Vibe is the workspace a non-technical user is meant to live in.',
      { present: { highlight: 'ViewModeVibe' }, waitFor: [{ click: 'ViewModeVibe' }] },
    ),
    // The workspace is ON SCREEN when its display pane is — which is what this
    // step actually means, and is true whether the user got here by the rail,
    // the recents list, or a reload.
    step(
      'open_build',
      'Open a build',
      'Click the speech-bubble icon in the left rail to reopen your last build. This is the real thing — an agent session, not a demo.',
      {
        present: { highlight: 'RailChats' },
        waitFor: [{ element: { present: 'VibeDisplay' } }],
      },
    ),
    step(
      'look_at_it',
      'This is what you have',
      'Chat on the left, the live display on the right, and its own row of tabs above it. Everything the agent shows you appears in the ringed half.',
      { present: { highlight: 'VibeDisplay' } },
    ),

    // ── out ──
    exitStep(
      'leave',
      'Now take the exit',
      'Click the speech bubble in the footer — Chat. One click, no confirmation.',
      'ViewModeChat',
      // The workspace is really gone — not "they clicked the button".
      { element: { gone: 'VibeDisplay' } },
    ),
    // ── back ──
    // The loss and the way back are ONE step on purpose. Splitting them left a
    // Continue sitting between "look at what went" and "click the wand", and the
    // natural reaction to losing your workspace is to reach for the way back
    // immediately — which then did not advance the journey.
    exitStep(
      'landed',
      'Look at what went, then come back',
      'The display is gone. So is the tab strip above it. The build is still running — you just cannot see anything it produces, and nothing told you that. Click the wand to return; nothing on screen says that is the way home.',
      'ViewModeVibe',
      { element: { present: 'VibeDisplay' } },
    ),
    step(
      'verdict',
      'That was the whole exit',
      'One unlabelled click out, one back, no warning either way. Decide: keep it, hide it behind the double-click reveal Dev already uses, or drop it from Vibe entirely.',
    ),
  ],
});

registerMemoryJourney({
  name: 'vibe-exit-mode-switch',
  title: 'Vibe exit — the footer mode switch',
  graph: VIBE_EXIT_MODE_SWITCH,
});
