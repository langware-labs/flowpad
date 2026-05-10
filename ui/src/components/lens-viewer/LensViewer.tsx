import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { dataContext } from '@sdk';
import { useMemo } from 'react';
import { CliLogViewer } from './CliLogViewer';
import { ClaudeContextViewer } from './ClaudeContextViewer';
import { ClaudeErrorsViewer } from './ClaudeErrorsViewer';
import { ClaudeTasksViewer } from './ClaudeTasksViewer';
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
      // Two URL forms supported:
      //   - legacy: {projectEncodedName}/{sessionId}  → resolve to ~/.claude/projects/<encoded>/<sid>.jsonl
      //   - direct: {urlEncoded(absolutePath)}        → use the path as-is (matches codex/transcript form)
      // Both feed GenericTranscriptViewer with worker_type="claude" so Claude
      // and Codex flow through the same server-parsed pipeline.
      const home = dataContext.bootstrapInfo?.desktop_info?.paths?.home;
      const ref = lensParts.ref;
      let path: string | null = null;
      const decoded = (() => {
        try { return decodeURIComponent(ref); } catch { return ref; }
      })();
      if (decoded.startsWith('/')) {
        path = decoded;
      } else {
        const lastSlash = ref.lastIndexOf('/');
        if (lastSlash >= 0 && home) {
          const projectEncodedName = ref.substring(0, lastSlash);
          const sessionId = ref.substring(lastSlash + 1);
          // Bootstrap may report `home` without the leading '/' on some
          // platforms — normalize so the path is absolute regardless.
          const homeAbs = home.startsWith('/') ? home : `/${home}`;
          path = `${homeAbs}/.claude/projects/${projectEncodedName}/${sessionId}.jsonl`;
        }
      }
      if (!path) {
        return (
          <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
            <p>Invalid transcript ref: expected projectEncodedName/sessionId or absolute path</p>
          </div>
        );
      }
      return <GenericTranscriptViewer workerType="claude" path={path} />;
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
