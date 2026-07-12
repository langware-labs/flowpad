/** Entity types the review modal offers "Run" for. */
export const TESTABLE_TYPES: ReadonlySet<string> = new Set(['skill']);

/**
 * First prompt of a skill-run session (pure — unit-tested).
 *
 * Addresses the skill by its **name**, not a filesystem path: the run flow
 * installs the skill into the conversation project first, so the Claude worker
 * resolves it from `.claude/skills/<name>/` by the frontmatter `name` (the
 * whole point of "download + index took care of that"). A path would only work
 * from the staging dir and reads as an implementation detail to the user.
 *
 * With a user prompt:   `use the skill <name> in order to:\n<prompt>`
 * Without (or blank):   `run the skill <name>`
 */
export function buildSkillTestPrompt(name: string, userPrompt?: string | null): string {
  const trimmed = (userPrompt ?? '').trim();
  if (!trimmed) return `run the skill ${name}`;
  return `use the skill ${name} in order to:\n${trimmed}`;
}

/**
 * The project to install+run a received skill in: an already-installed project
 * scope wins, then the conversation's project, then the active project. Returns
 * null when none is resolvable — the caller then prompts for one (a shared
 * conversation is often projectless on the receiver). `||`, not `??`: the
 * backend clears project_id with '' (exclude-none saves), so fall through.
 */
export function resolveRunProjectId(
  attachment: { project_id?: string | null },
  conversationProjectId?: string | null,
  activeProjectId?: string | null,
): string | null {
  return attachment.project_id || conversationProjectId || activeProjectId || null;
}
