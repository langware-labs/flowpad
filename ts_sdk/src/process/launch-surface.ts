/**
 * Which surface launches processes from this JS runtime.
 *
 * The Flowpad app sets `'app'` once at boot (`ui/src/main.tsx`); a TS SDK
 * script never calls the setter. Every process-creating call (`createProcess`
 * via `serializeAgenticContext`, `Agent.use`, the agent auto-launch, a
 * session adopted by `getByWorkerId`) carries it, and the backend writes it
 * to `context_data.launch_surface`. Its one consumer is the `COMMON_UI`
 * system-prompt layer (`flow_sdk/builtin/agentic_process/system_prompt.py`):
 * `common_ui.md` reaches only processes the app launched.
 */
export type LaunchSurface = 'app';

let surface: LaunchSurface | null = null;

export function setLaunchSurface(value: LaunchSurface | null): void {
  surface = value;
}

/** `{ launch_surface }` to spread into a request body — `{}` when unset. */
export function launchSurfaceField(): { launch_surface?: LaunchSurface } {
  return surface ? { launch_surface: surface } : {};
}
