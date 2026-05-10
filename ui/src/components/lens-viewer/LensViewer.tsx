import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useMemo } from 'react';
import { CliLogViewer } from './CliLogViewer';
import { ClaudeContextViewer } from './ClaudeContextViewer';
import { ClaudeErrorsViewer } from './ClaudeErrorsViewer';
import { ClaudeTasksViewer } from './ClaudeTasksViewer';
import { ClaudeTranscriptViewer } from './claude-transcript-viewer';
import { FsRecordsScannerViewer } from './FsRecordsScannerViewer';
import { TranscriptViewer } from './shared/transcript-features';
import { HeartbeatEventsViewer } from './HeartbeatEventsViewer';
import { TriggerLogViewer } from './TriggerLogViewer';

/**
 * LensViewer - Main router component that delegates to sub-viewers based on lens type
 *
 * URL structure: /dock/lens/{category}/{type}/{ref}
 * Examples:
 * - /dock/lens/claude/transcript/{projectEncodedName}/{sessionId}
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
          <p className="text-lg font-medium">Invalid Lens URL</p>
          <p className="mt-1 text-sm">The lens path could not be parsed.</p>
        </div>
      </div>
    );
  }

  // Route to appropriate lens viewer based on category/type
  const lensKey = `${lensParts.category}/${lensParts.type}`;

  switch (lensKey) {
    case 'claude/transcript': {
      // Two URL forms — DIFFERENT renderers (so we can side-by-side compare):
      //   - legacy form `{projectEncodedName}/{sessionId}` → ClaudeTranscriptViewer
      //     (the original raw-JSONL renderer; preserved as the reference).
      //   - new form    `{urlEncodedAbsolutePath}`         → unified TranscriptViewer
      //     (the worker-agnostic renderer that consumes the server-parsed entries).
      // Once the two views are proven identical, the legacy renderer goes away
      // and both forms collapse to the new TranscriptViewer.
      const ref = lensParts.ref;
      const decoded = (() => {
        try { return decodeURIComponent(ref); } catch { return ref; }
      })();
      if (decoded.startsWith('/')) {
        return (
          <TranscriptViewer
            workerType="claude"
            path={decoded}
            selectedEntryId={currentDock?.options?.transcript_entry_id}
            selectedTimestamp={currentDock?.options?.ts}
          />
        );
      }
      // Legacy form: project-encoded-name + session-id, fed to the legacy renderer
      // for an apples-to-apples reference image.
      const lastSlash = ref.lastIndexOf('/');
      if (lastSlash < 0) {
        return (
          <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
            <p>Invalid transcript ref: expected projectEncodedName/sessionId or absolute path</p>
          </div>
        );
      }
      return (
        <ClaudeTranscriptViewer
          projectEncodedName={ref.substring(0, lastSlash)}
          sessionId={ref.substring(lastSlash + 1)}
          selectedEntryId={currentDock?.options?.transcript_entry_id}
          selectedTimestamp={currentDock?.options?.ts}
        />
      );
    }
    case 'codex/transcript': {
      // ref is the URL-encoded absolute path to the rollout JSONL.
      const path = decodeURIComponent(lensParts.ref || '');
      if (!path) {
        return (
          <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
            <p>Invalid transcript ref: expected an absolute path</p>
          </div>
        );
      }
      return (
        <TranscriptViewer
          workerType="codex"
          path={path}
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
          projectEncodedName={currentDock?.options?.project}
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
    case 'trigger/log':
      return <TriggerLogViewer triggerId={lensParts.ref} />;
    default:
      return (
        <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
          <div className="text-center">
            <p className="text-lg font-medium">Unknown Lens Type</p>
            <p className="mt-1 text-sm">
              Lens type &quot;{lensParts.category}/{lensParts.type}&quot; is not supported.
            </p>
          </div>
        </div>
      );
  }
}
