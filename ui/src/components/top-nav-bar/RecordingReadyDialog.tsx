import { useState } from 'react';
import { FolderInput, RotateCcw, Share2, Trash2, Video } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { ActionInfo, dataManager, TypeId, VFSPath } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { ShareToConversationDialog } from '@src/components/share-to-conversation/ShareToConversationDialog';
import { useFileShareSource } from '@src/hooks/use-file-share-source';
import { useContext } from '@src/hooks/useContext';
import { notify } from '@src/notifications/notify';
import { dockPointerForFile } from '@src/navigation/local-file-pointer';
import { formatBytes } from '@src/utils/format-bytes';
import type { UploadDir } from '@src/utils/upload-to-input-dir';
import { dismissRecording, formatElapsed, setRecordingPlace, startRecording, type Recording, type RecordingPlace } from './use-screen-recorder';

/** The toast's Open: the saved recording in its viewer (URL-first, like every toast link). */
function recordingHref(place: RecordingPlace): string {
  return dockPointerForFile(VFSPath.fromMachinePath(place.absPath, new TypeId(place.computeNodeId)).rawPath).toUrl();
}

/**
 * "Recording ready": a preview, the file's name and size, and the two ways on — Share
 * (the standard share-to-conversation dialog, with the file where it sits now; closing it
 * ends the flow) or Save to project (the backend moves it under `<project>/recordings/`,
 * then only Share is left). Close keeps the file in the temp folder.
 */
export function RecordingReadyDialog({ recording }: { recording: Recording }) {
  const { t } = useLingui();
  const { project } = useContext();
  const [sharing, setSharing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileName = recording.file.name;
  // Lazy: the share source mints a shared-file artifact, so ask only once Share is clicked.
  const source = useFileShareSource(new TypeId(recording.computeNodeId), sharing ? recording.absPath : null);

  const saveToProject = async () => {
    if (!project?.id) return;
    setSaving(true);
    try {
      const action = new ActionInfo('recording-save-to-project', null, null, 'POST');
      action.bodyParameters = { name: fileName, project_id: project.id };
      const moved = await dataManager.callAction<{ name: string; project_id: string }, UploadDir>(action);
      const place: RecordingPlace = { absPath: moved.abs_path, computeNodeId: moved.compute_node_id };
      setRecordingPlace(place);
      setSaved(true);
      notify.success({
        title: t`Saved to project`,
        message: `${project.name}/recordings/${fileName}`,
        actions: [{ label: t`Open`, href: recordingHref(place) }],
      });
    } catch (error) {
      notify.error({ title: t`Could not save to the project`, message: error instanceof Error ? error.message : String(error), transient: true });
    } finally {
      setSaving(false);
    }
  };

  // Discard deletes the temp file; Record again does that, then starts a new recording.
  const discard = async (again: boolean) => {
    setSaving(true);
    try {
      const action = new ActionInfo('recording-discard', null, null, 'POST');
      action.bodyParameters = { name: fileName };
      await dataManager.callAction(action);
    } catch (error) {
      notify.error({ title: t`Could not delete the recording`, message: error instanceof Error ? error.message : String(error), transient: true });
      setSaving(false);
      return;
    }
    dismissRecording();
    if (again) void startRecording();
  };

  if (sharing) {
    return source && <ShareToConversationDialog open onClose={dismissRecording} source={source} projectId={project?.id ?? null} />;
  }

  return (
    <Dialog open onOpenChange={(open) => !open && dismissRecording()}>
      <DialogContent className="sm:max-w-md" data-testid="recording-ready-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Video className="h-5 w-5 text-primary" />
            {t`Recording ready`}
          </DialogTitle>
          <DialogDescription className="sr-only">{t`Share the recording or save it to the project.`}</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4 text-sm">
          <video
            src={recording.objectUrl}
            controls
            muted
            playsInline
            className="aspect-video w-full rounded-md border bg-muted"
            data-testid="recording-preview"
          />
          <div className="flex flex-col gap-1">
            <p className="truncate font-mono text-xs text-foreground" data-testid="recording-file-name">
              {fileName}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatElapsed(recording.durationMs)} · {formatBytes(recording.file.size)} ·{' '}
              {saved ? t`in the project under recordings/` : t`kept in Flowpad's temp folder until you save it`}
            </p>
          </div>
        </div>
        <DialogFooter className="gap-2">
          {!saved && (
            <>
              <Button variant="ghost" className="sm:mr-auto" onClick={() => void discard(false)} disabled={saving} data-testid="recording-discard">
                <Trash2 className="h-4 w-4" />
                {t`Discard`}
              </Button>
              <Button variant="outline" onClick={() => void discard(true)} disabled={saving} data-testid="recording-record-again">
                <RotateCcw className="h-4 w-4" />
                {t`Record again`}
              </Button>
            </>
          )}
          {!saved && (
            <Button variant="outline" onClick={() => void saveToProject()} disabled={saving || !project?.id} data-testid="recording-save-to-project">
              <FolderInput className="h-4 w-4" />
              {t`Save to project`}
            </Button>
          )}
          <Button onClick={() => setSharing(true)} data-testid="recording-share">
            <Share2 className="h-4 w-4" />
            {t`Share`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
