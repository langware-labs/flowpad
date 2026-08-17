/**
 * Probe journeys — code-defined journeys that demonstrate a behaviour we are
 * reviewing, rather than teaching a user something.
 *
 * Imported for SIDE EFFECT (each module registers itself), from
 * `JourneyController` — the journey feature's one mount point — so a probe is
 * reachable by URL as soon as the app boots and nothing else has to know.
 *
 * The current campaign: every way a non-technical user can leave the Vibe
 * workspace, one journey per exit, open at `?journeyId=@<name>`.
 */
import './vibe-exit-mode-switch';
