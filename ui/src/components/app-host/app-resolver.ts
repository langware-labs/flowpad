import { dataManager, FLOWPAD_ASSISTANT_PROJECT_UNAME, fsManager, Project, TypeId } from '@sdk';

// Skill folder names are user-facing slugs. We forbid anything that could
// traverse out of `.claude/skills/<uname>/` — only [a-z0-9_-] and a length
// cap. The URL params decode `..%2F..` into literal `..` segments before
// reaching us, so the regex check is the only defense.
const UNAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/;

/**
 * Resolves a Flowpad app uname to its UI HTML.
 *
 * V1: all apps live as skills inside the flowpad_assistant system project at
 * `<fs_storage_mount_path>/.claude/skills/<uname>/ui/main.html`. The compute node
 * is `@local` (system projects always live on the user's machine); paths through
 * it are absolute filesystem paths, so we anchor on the project's mount path.
 *
 * Future: replace with a pluggable app registry that resolves from multiple
 * sources (system projects, user projects, remote registries).
 */
export async function resolveAppHtml(uname: string): Promise<string> {
  if (!UNAME_RE.test(uname)) {
    throw new Error(`Invalid app uname: ${JSON.stringify(uname)}`);
  }
  const projectTypeId = new TypeId(Project.type, `@${FLOWPAD_ASSISTANT_PROJECT_UNAME}`);
  const project = await dataManager.getByTypeId<Project>(projectTypeId);
  if (!project) {
    throw new Error(`Could not resolve flowpad_assistant project for app '${uname}'`);
  }
  // System projects store an absolute mount path; the @local compute node
  // serves absolute filesystem paths through fsManager.download.
  const mountPath = (project as unknown as { fs_storage_mount_path?: string }).fs_storage_mount_path;
  if (!mountPath) {
    throw new Error(`flowpad_assistant has no fs_storage_mount_path — cannot load app '${uname}'`);
  }
  const computeNode = await project.getComputeNode();
  if (!computeNode || !computeNode.id) {
    throw new Error(`flowpad_assistant has no compute node — cannot load app '${uname}'`);
  }
  const cnTypeId = new TypeId('compute_node', computeNode.id);
  const htmlPath = `${mountPath.replace(/\/+$/, '')}/.claude/skills/${uname}/ui/main.html`;
  const content = await fsManager.download(cnTypeId, htmlPath);
  if (typeof content !== 'string') {
    throw new Error(`App HTML at ${htmlPath} is not a string`);
  }
  return content;
}
