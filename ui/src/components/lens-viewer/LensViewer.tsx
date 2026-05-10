import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useMemo } from 'react';
import { CliLogViewer } from './CliLogViewer';
import { ClaudeContextViewer } from './ClaudeContextViewer';
import { ClaudeErrorsViewer } from './ClaudeErrorsViewer';
import { ClaudeTasksViewer } from './ClaudeTasksViewer';
import { ClaudeTranscriptViewer } from './claude-transcript-viewer';
import { FsRecordsScannerViewer } from './FsRecordsScannerViewer';
import { GenericTranscriptViewer } from './generic-transcript-viewer';
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
      // ref format: {projectEncodedName}/{sessionId}
      const lastSlash = lensParts.ref.lastIndexOf('/');
      if (lastSlash < 0) {
        return (
          <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
            <p>Invalid transcript ref: expected projectEncodedName/sessionId</p>
          </div>
        );
      }
      return (
        <ClaudeTranscriptViewer
          projectEncodedName={lensParts.ref.substring(0, lastSlash)}
          sessionId={lensParts.ref.substring(lastSlash + 1)}
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
      return <GenericTranscriptViewer workerType="codex" path={path} />;
    }
    case 'claude/transcript-path': {
      // Path-based variant of the claude transcript lens — used when the
      // transcript is reachable via a known filesystem path (e.g. a
      // `conversation.jsonl` file attached to a FlowMessage) rather than a
      // discoverable session-id. ref is the URL-encoded absolute path.
      const path = decodeURIComponent(lensParts.ref || '');
      if (!path) {
        return (
          <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
            <p>Invalid transcript ref: expected an absolute path</p>
          </div>
        );
      }
      return <GenericTranscriptViewer workerType="claude" path={path} />;
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
