import {
  Artifact,
  ArtifactType,
  ComputeNode,
  dataContext,
  formatGitOrigin,
  gitOriginCloneUrl,
  launchWizard,
  ProcessKind,
  Project,
  TypeId,
} from '@sdk';
import type { NavigationActions } from '@src/navigation';
import { ViewMode } from '@src/contexts/view-mode-context';
import { notify } from '@src/notifications/notify';

interface OpenArtifactOptions {
  navigation: NavigationActions;
  currentProjectId?: string | null;
}

function artifactPort(artifact: Artifact): string | null {
  const raw = artifact.port ?? artifact.metadata?.port;
  return raw == null || raw === '' ? null : String(raw);
}

function appPrompt(args: {
  artifact: Artifact;
  localPath: string;
  projectRoot: string;
}): string {
  const { artifact, localPath, projectRoot } = args;
  const details = {
    typeid: artifact.typeId.toString(),
    name: artifact.displayName,
    artifact_type: artifact.artifact_type,
    localPath,
    projectRoot,
    port: artifactPort(artifact),
    start_cmd: artifact.start_cmd ?? artifact.metadata?.start_cmd ?? artifact.metadata?.['start-cmd'] ?? null,
    health: artifact.health ?? artifact.metadata?.health ?? null,
    git_origin: artifact.git_origin ?? null,
  };
  return [
    'Start the app. Use the existing app from these artifact details; do not rebuild it.',
    '',
    `Details:\n${JSON.stringify(details, null, 2)}`,
    '',
    'Use the Flowpad app opener from the project root, for example:',
    `flow app open "${artifact.displayName}" --root "${projectRoot}"`,
    '',
    'When the app is running, it must be shown in the Vibe display.',
  ].join('\n');
}

async function launchVibeForWebApp(artifact: Artifact, localPath: string, project: Project | null, navigation: NavigationActions): Promise<void> {
  const projectId = project?.id ?? artifact.project_id ?? dataContext.project?.id ?? null;
  const projectRoot = project?.fs_storage_mount_path ?? dataContext.project?.fs_storage_mount_path ?? localPath;
  const computeNode = await ComputeNode.getById('@local');
  if (!computeNode) throw new Error('No local compute node');

  const target = projectId ? new TypeId(Project.type, projectId).toString() : artifact.typeId.toString();
  const process = await computeNode.createProcess(
    {
      workdir: projectRoot,
      ...(projectId ? { projectId } : {}),
      targetVfsPath: target,
      processType: ProcessKind.Chat,
      loadFlowpadAssistant: true,
      outputFormat: 'stream-json',
      contextData: {
        source_artifact_id: artifact.id ?? null,
        source_artifact_typeid: artifact.typeId.toString(),
        launched_from: 'git_artifact_share',
      },
    },
    {
      visible: false,
      pty_mode: false,
      watchProcess: false,
      launchPrompt: appPrompt({ artifact, localPath, projectRoot }),
    },
  );
  void navigation.openShellProcess(process.id, { viewMode: ViewMode.Vibe });
}

export async function openArtifact(artifact: Artifact, opts: OpenArtifactOptions): Promise<void> {
  const { navigation, currentProjectId } = opts;
  const isWebApp = artifact.artifact_type === ArtifactType.WEBAPP;
  const hasPort = artifactPort(artifact) !== null;

  if (isWebApp && hasPort) {
    if (artifact.git_origin) {
      let result = await artifact.resolveGitLocation({ currentProjectId: currentProjectId ?? dataContext.project?.id ?? null });
      if (result.kind === 'needs_wizard') {
        const wizardResult = await launchWizard<{ projectId?: string; localPath?: string }>('git-setup', {
          title: `Set up ${artifact.displayName}`,
          targetTypeId: artifact.typeId.toString(),
          payload: {
            artifactId: artifact.id,
            gitOrigin: result.gitOrigin,
            cloneUrl: gitOriginCloneUrl(result.gitOrigin),
            branch: result.gitOrigin.branch,
            relPath: result.gitOrigin.rel_path,
            reason: result.reason,
          },
          prompt: `Help me setup this git-backed webapp artifact.

Repository: ${formatGitOrigin(result.gitOrigin)}
Clone URL: ${gitOriginCloneUrl(result.gitOrigin)}
Branch: ${result.gitOrigin.branch || '(default)'}
Artifact path in repo: ${result.gitOrigin.rel_path}
Reason setup is needed: ${result.reason}

Clone or locate the repository, create or identify the Flowpad project for that checkout, then close the wizard with data:
{"localPath":"<checkout root>","projectId":"<project id>"}`,
        });
        if (wizardResult.status !== 'done') {
          if (wizardResult.status === 'error') {
            notify.error({ title: 'Git setup failed', message: wizardResult.errorStr ?? 'Wizard failed' });
          }
          return;
        }
        result = await artifact.resolveGitLocation({
          currentProjectId: currentProjectId ?? dataContext.project?.id ?? null,
          localPath: wizardResult.data?.localPath ?? null,
          projectId: wizardResult.data?.projectId ?? null,
        });
      }
      if (result.kind === 'error') {
        notify.error({ title: 'Could not open app', message: result.message });
        return;
      }
      if (result.kind === 'needs_wizard') {
        notify.error({ title: 'Git setup incomplete', message: result.reason });
        return;
      }
      await launchVibeForWebApp(result.artifact, result.localPath, result.project, navigation);
      return;
    }
    navigation.openWebApp(artifactPort(artifact)!);
    return;
  }

  if (artifact.path) {
    navigation.openFile(artifact.path);
  }
}
