import { DockLoadError } from './dock-load-error';
import { describeProcessStartError, type ProcessLoadError } from './load-process';

export function processLoadErrorToDockError(error: ProcessLoadError, source: string): DockLoadError {
  if (error.kind === 'entity_not_found') {
    return new DockLoadError(
      'session_not_found',
      'hard',
      {
        action: 'render_error',
        title: 'Session not found',
        message: 'Agentic process does not exist.',
      },
      source,
      error,
    );
  }
  if (error.kind === 'network_error') {
    return new DockLoadError(
      'session_network_error',
      error.severity,
      {
        action: 'render_error',
        title: 'Session unavailable',
        message: 'Could not reach the backend. Try again in a moment.',
        retryable: true,
      },
      source,
      error,
    );
  }
  if (error.kind === 'runtime_terminated' || error.kind === 'pty_attach_failed' || error.kind === 'failed_to_start') {
    const { title, description } = describeProcessStartError(error.cause ?? error);
    return new DockLoadError(
      `session_${error.kind}`,
      'soft',
      {
        action: 'render_error',
        title,
        message: description,
        retryable: true,
      },
      source,
      error,
    );
  }
  if (error.kind === 'project_missing') {
    return new DockLoadError(
      'session_project_missing',
      'soft',
      {
        action: 'render_error',
        title: 'Project not found',
        message: "Could not recover this session's project.",
      },
      source,
      error,
    );
  }
  return new DockLoadError(
    'session_shell_missing',
    'soft',
    {
      action: 'render_error',
      title: 'Session unavailable',
      message: 'No shell is linked to this process.',
    },
    source,
    error,
  );
}
