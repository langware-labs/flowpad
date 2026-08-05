/**
 * Shape of a ```breadcrumb block: which tests a rules doc governs.
 *
 *     ```breadcrumb
 *     tag: breadcrumb.test.catchup_login.rules
 *     sites:
 *       - rel_path: tests/unit/test_catchup.py
 *         line: 41
 *         note: FAILING? read this tag's rules before editing
 *     ```
 *
 * Written by the `tagit` skill next to the `tag` capsule it drops on the test,
 * and read back by the renderer, which refreshes it from the live tag index.
 *
 * **Degradation differs from `interface` on purpose.** There, the YAML *is* the
 * content, so anything malformed throws and the block shows an error. Here
 * `sites` is a script-written cache of something the tag index owns: the block's
 * identity is `tag` alone. So a bad row is collected into `issues[]` and drawn
 * as a disabled chip, and only a block with no usable identity throws. A bug in
 * the writing script must not blank a card whose tag still resolves.
 */

import { isSafeRelPath, normalizeTag } from '@sdk';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * `sites` is validated as an opaque list, NOT `z.array(siteSchema)`.
 *
 * zod would reject the whole array on the first bad element, which is exactly
 * the all-or-nothing behaviour this block must not have. Rows are validated one
 * at a time below so a single malformed entry costs one chip, not the card.
 */
export const breadcrumbSpecSchema = z.object({
  tag: z.string().min(1, 'tag must not be empty'),
  sites: z.array(z.unknown()).optional(),
});

const siteSchema = z.object({
  rel_path: z.string().min(1, 'rel_path must not be empty'),
  line: z.number().int().positive().optional(),
  note: z.string().optional(),
});

/** One test the tag is bound to. `relPath` is relative to the project root. */
export interface BreadcrumbSite {
  relPath: string;
  line?: number;
  note?: string;
}

/** A row that could not be read, kept so the card can show it went wrong. */
export interface BreadcrumbSiteIssue {
  index: number;
  reason: string;
}

/** Normalized form the renderer draws from. */
export interface BreadcrumbSpec {
  /** Canonical tag name — the cache key and the request body. */
  tag: string;
  sites: BreadcrumbSite[];
  issues: BreadcrumbSiteIssue[];
}

/**
 * Parse and validate a `breadcrumb` block body.
 *
 * Throws only when the block has no identity — the NodeView surfaces the
 * message as an inline chip with the source one tab away. Row-level problems
 * come back in `issues` instead.
 */
export function parseBreadcrumbBlock(source: string): BreadcrumbSpec {
  if (!source.trim()) throw new Error('Empty breadcrumb block');

  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    throw new Error(`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('A breadcrumb block must be a YAML mapping with a `tag` key');
  }

  const result = breadcrumbSpecSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join('.');
    throw new Error(path ? `${path}: ${issue.message}` : issue.message);
  }

  // Normalized at parse time, not at request time: the canonical name is the
  // cache key, so two spellings of one tag must collapse onto a single
  // filesystem walk. It also rejects here what the backend would 400 on.
  let tag: string;
  try {
    tag = normalizeTag(result.data.tag);
  } catch (error) {
    throw new Error(`tag: ${error instanceof Error ? error.message : String(error)}`);
  }

  const sites: BreadcrumbSite[] = [];
  const issues: BreadcrumbSiteIssue[] = [];

  (result.data.sites ?? []).forEach((row, index) => {
    const parsed = siteSchema.safeParse(row);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue.path.join('.');
      issues.push({ index, reason: path ? `${path}: ${issue.message}` : issue.message });
      return;
    }
    // The same repo-relative safety rule the backend enforces, applied at the
    // earliest point the path is known. `resolveRelPath` checks it again before
    // navigation; this one exists so a bad row is visibly a bad ROW.
    if (!isSafeRelPath(parsed.data.rel_path)) {
      issues.push({ index, reason: `rel_path: unsafe path "${parsed.data.rel_path}"` });
      return;
    }
    sites.push({
      relPath: parsed.data.rel_path,
      line: parsed.data.line,
      note: parsed.data.note,
    });
  });

  return { tag, sites, issues };
}

/** `tests/unit/test_x.py:41` — what a site chip reads. */
export function formatSiteLabel(site: BreadcrumbSite): string {
  return site.line ? `${site.relPath}:${site.line}` : site.relPath;
}
