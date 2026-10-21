/**
 * Whether a hub-read asset cannot be shown because it has no git link.
 *
 * On the hub, a git-transported type's files come from its git source (the
 * project's hub repo, or a linked repository) through the same SDK `record` /
 * `fs` calls the desk uses locally. An entity of such a type with no `origin`
 * has no source the hub can read, so the hub answers `record/refs` with 404:
 * that is "connect git", not "missing asset".
 */
export function needsGitConnection(
  hubReflect: boolean,
  cloudFileTransport: string | null | undefined,
  entity: object | null | undefined,
): boolean {
  if (!hubReflect || !entity || cloudFileTransport !== 'git') return false;
  const { origin, git_origin } = entity as { origin?: unknown; git_origin?: unknown };
  return !origin && !git_origin;
}
