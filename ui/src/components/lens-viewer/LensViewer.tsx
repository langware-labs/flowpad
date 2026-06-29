import { dataContext, isAbsoluteMachinePath } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Trans } from '@lingui/react/macro';
import { useMemo } from 'react';
import { CliLogViewer } from './CliLogViewer';
import { ClaudeContextViewer } from './ClaudeContextViewer';
import { ClaudeErrorsViewer } from './ClaudeErrorsViewer';
import { ClaudeTasksViewer } from './ClaudeTasksViewer';
import { FsRecordsScannerViewer } from './FsRecordsScannerViewer';
import { LlmIndexersViewer } from './LlmIndexersViewer';
import { TranscriptViewer } from './shared/transcript-features';
import { HeartbeatEventsViewer } from './HeartbeatEventsViewer';
import { TriggerLogViewer } from './TriggerLogViewer';

/**
 * LensViewer - Main router component that delegates to sub-viewers based on lens type
 *
 * URL structure: /dock/lens/{category}/{type}/{ref}
 * Examples:
 * - /dock/lens/claude/transcript/{sessionId}
 * - /dock/lens/claude/tasks/{sessionId}
 */
export function LensViewer() {
  const { currentDock } = useDockNavigation();

  // Parse the pointer to determine lens type
  const lensParts = useMemo(() => {
    if (!currentDock?.pointer) return null;
    return DockPointer.parseLensPointer(currentDock.pointer);
  }, [currentDock?.pointer]);

  if (!lensParts) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
        <div className="text-center">
          <p className="text-lg font-medium"><Trans>Invalid Lens URL</Trans></p>
          <p className="mt-1 text-sm"><Trans>The lens path could not be parsed.</Trans></p>
        </div>
      </div>
    );
  }

  // Route to appropriate lens viewer based on category/type
  const lensKey = `${lensParts.category}/${lensParts.type}`;

  switch (lensKey) {
    case 'claude/transcript':
    case 'codex/transcript':
    case 'copilot/transcript':
    case 'workflow/transcript': {
      // Three URL forms collapse onto the worker-agnostic TranscriptViewer:
      //   1. canonical form   `<sessionId>`                     → server resolves the JSONL
      //   2. absolute path    `<urlEncodedAbsolutePath>`        → useTranscript fetches via ?path=
      //   3. legacy form      `<projectEncodedName>/<sessionId>` → bridged to abs path here
      // (1) is what `process.transcriptDockPointer` emits today. (2) is the
      // power-user / debug form. (3) is kept for bookmarks emitted by the
      // pre-Phase-9 transcriptDockPointer shape.
      const workerType = lensParts.category as 'claude' | 'codex' | 'copilot' | 'workflow';
      const ref = lensParts.ref;
      const decoded = (() => {
        try { return decodeURIComponent(ref); } catch { return ref; }
      })();

      // Form 2: absolute path — POSIX (``/…``) or Windows (``C:\…``).
      // Forwarded to ``TranscriptViewer path={…}`` as-is; the backend reads
      // the file with its native OS path semantics.
      if (isAbsoluteMachinePath(decoded)) {
        return (
          <TranscriptViewer
            workerType={workerType}
            path={decoded}
            selectedEntryId={currentDock?.options?.transcript_entry_id}
            selectedTimestamp={currentDock?.options?.ts}
          />
        );
      }

      // Form 3: legacy two-segment claude form. Bridge to abs path.
      if (workerType === 'claude' && ref.includes('/')) {
        // Guard: the legacy form is exactly `<projectEncodedName>/<sessionId>`
        // with a single internal "/". If the prefix contains more slashes, the
        // ref is a mangled absolute path that lost its leading "/" (e.g. via
        // react-router's "//" normalisation) — refuse to silently rewrite it
        // under ~/.claude/projects/ and surface a clear error instead.
        const lastSlash = ref.lastIndexOf('/');
        if (ref.substring(0, lastSlash).includes('/')) {
          return (
            <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
              <div className="text-center">
                <p className="text-lg font-medium"><Trans>Invalid transcript path</Trans></p>
                <p className="mt-1 text-sm"><Trans>Got a relative-looking ref with multiple segments: <code>{ref}</code></Trans></p>
              </div>
            </div>
          );
        }
        const projectEncodedName = ref.substring(0, lastSlash);
        const sessionId = ref.substring(lastSlash + 1);
        const rawHome = dataContext.bootstrapInfo?.desktop_info?.paths?.home;
        const home = rawHome ? (rawHome.startsWith('/') ? rawHome : `/${rawHome}`) : null;
        if (!home) {
          return (
            <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
              <p><Trans>Could not resolve home directory from bootstrap info</Trans></p>
            </div>
          );
        }
        const absPath = `${home}/.claude/projects/${projectEncodedName}/${sessionId}.jsonl`;
        return (
          <TranscriptViewer
            workerType="claude"
            path={absPath}
            selectedEntryId={currentDock?.options?.transcript_entry_id}
            selectedTimestamp={currentDock?.options?.ts}
          />
        );
      }

      // Form 1: canonical session id.
      return (
        <TranscriptViewer
          workerType={workerType}
          sessionId={ref}
          selectedEntryId={currentDock?.options?.transcript_entry_id}
          selectedTimestamp={currentDock?.options?.ts}
        />
      );
    }
    case 'claude/tasks':
      return (
        <ClaudeTasksViewer
          sessionId={lensParts.ref}
          selectedActiveForm={currentDock?.options?.active_form}
        />
      );
    case 'heartbeat/events':
      return (
        <HeartbeatEventsViewer
          viewMode={lensParts.ref === 'json' ? 'json' : 'live'}
          selectedEventId={currentDock?.options?.eventId}
          selectedTimestamp={currentDock?.options?.ts}
        />
      );
    case 'heartbeat/errors':
      return <ClaudeErrorsViewer initialStatusSlug={lensParts.ref} />;
    case 'cli/log':
      return <CliLogViewer />;
    case 'claude/context':
      return <ClaudeContextViewer />;
    case 'fs-records/scan':
      return <FsRecordsScannerViewer />;
    case 'fs-records/llm-indexers':
      return <LlmIndexersViewer />;
    case 'trigger/log':
      return <TriggerLogViewer triggerId={lensParts.ref} />;
    default:
      return (
        <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
          <div className="text-center">
            <p className="text-lg font-medium"><Trans>Unknown Lens Type</Trans></p>
            <p className="mt-1 text-sm">
              <Trans>Lens type "{lensParts.category}/{lensParts.type}" is not supported.</Trans>
            </p>
          </div>
        </div>
      );
  }
}
