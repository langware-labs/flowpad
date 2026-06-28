// Shared setup for the `api` test tier.
//
// Leak tripwire only (no per-test purge): api tests run against a temp-isolated
// records root and self-clean, so this just guards against a future live-create
// that forgets to clean up. See `installLeakTripwire` in `../_cleanup` for the
// mechanism (sweeps for the `e2etest-*` marker; no-ops when offline).
import { installLeakTripwire } from '../_cleanup';

installLeakTripwire(['skill']);
