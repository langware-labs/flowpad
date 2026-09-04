/**
 * The ambient journey feature — the `auto_launch` redirect and the left-rail
 * badge — is hidden for now.
 *
 * Only the AMBIENT surfaces are off: a journey the user asks for by name still
 * runs (the `SetupJourneyButton` paths write `?journeyId=` and the tray opens
 * on it). Flip this back to `true` to bring the auto-launch and the badge back;
 * nothing else has to be undone.
 */
export const AMBIENT_JOURNEYS_ENABLED = false;
