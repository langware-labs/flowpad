import type { AgenticProcess } from '@sdk';

/**
 * Resolve an AgenticProcess's human display name with a single precedence:
 *   context_data.display_name → process.name → instruction_content
 *   (HTML-comment-stripped) → 'Session'.
 *
 * `instructionMaxLength` clips ONLY the instruction_content fallback (which can
 * be long / multi-line) for confined surfaces like the terminal header; an
 * explicit display_name/name is returned full (callers truncate visually with
 * CSS). Omit it for the full name (e.g. the tab tooltip heading).
 */
export function resolveProcessDisplayName(process: AgenticProcess, instructionMaxLength?: number): string {
  const cd = process.context_data as Record<string, unknown> | undefined;
  const dn = cd && typeof cd.display_name === 'string' ? cd.display_name.trim() : '';
  if (dn) return dn;

  const name = (process as { name?: string | null }).name;
  if (typeof name === 'string' && name.trim().length > 0) return name.trim();

  if (process.instruction_content) {
    const trimmed = process.instruction_content.replace(/<!--.*?-->/g, '').trim();
    if (trimmed.length > 0) {
      return instructionMaxLength ? trimmed.substring(0, instructionMaxLength) : trimmed;
    }
  }
  return 'Session';
}
