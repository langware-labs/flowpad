/**
 * Shape of the lw (langware) blocks a statement doc holds — see `docs/lw.md`.
 *
 *     ```statements
 *     tag: machine_access.remote_control
 *     depends_on:
 *       - machine_access.privileged_access
 *     statements:
 *       - text: Remote control is flow connect with a node created locked.
 *         basis: stated
 *         issues:
 *           - No node carries a "locked" setting.
 *     ```
 *
 * A statements block may also carry `requirements`, a list of `{ text }`: what
 * must be built to make its statements true.
 * A `test_debug` block is what tagit writes in a rules doc: `sites` (the bound
 * tests) and `proven` around the same `tag`, `depends_on` and `statements`.
 *
 * TS twin of `flow_sdk/schema/data_spec/lw_spec.py`, which owns the rules. The
 * two answer "is this block valid" identically: `tests/fixtures/lw_blocks_contract.json`
 * is read by both `tests/unit/test_lw.py` and `ui/tests/unit/lw-schema.test.ts`.
 *
 * Strict, like `interface`: the YAML *is* the content, so a malformed block
 * throws and the host shows the message with the source one tab away.
 */

import { isSafeRelPath, normalizeTag } from '@sdk';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { BreadcrumbSite } from './breadcrumb-schema';

export type LwBlockKind = 'statements' | 'test_debug';

const tag = z.string().refine(
  (value) => {
    try {
      return normalizeTag(value) === value;
    } catch {
      return false;
    }
  },
  { message: 'must be a lowercase dot-separated tag' },
);

const sentence = z.string().refine((value) => value.trim().length > 0, { message: 'must be a non-empty sentence' });

const ABOUT = /^(.*):(\d+)$/;

/** `path` or `path:line` -> the path and its line. */
export function splitAbout(value: string): LwFileRef {
  const found = ABOUT.exec(value);
  return found ? { relPath: found[1], line: Number(found[2]) } : { relPath: value };
}

const about = z.string().superRefine((value, ctx) => {
  const { relPath, line } = splitAbout(value);
  if (!isSafeRelPath(relPath)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a path inside the project' });
  if (line === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a line starts at 1' });
});

const site = z
  .object({
    rel_path: z.string().refine(isSafeRelPath, { message: 'must be a path inside the project' }),
    line: z.number().int().positive().nullish(),
    note: z.string().nullish(),
  })
  .strict();

/** The two mistakes an author is most likely to make, said in the words the backend uses. */
const noIdNoRequirements = (value: unknown, ctx: z.RefinementCtx) => {
  if (value == null || typeof value !== 'object') return;
  if ('id' in value) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a statement has no id' });
  if ('requirements' in value || 'changes' in value) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a statement has no requirements; they are the block's own requirements list",
    });
  }
};

const statement = z.unknown().superRefine(noIdNoRequirements).pipe(
  z
    .object({
      text: sentence,
      basis: z.enum(['stated', 'proven']).optional(),
      issues: z.array(sentence).optional(),
      about: z.array(about).optional(),
    })
    .strict(),
);

const requirement = z.object({ text: sentence }).strict();

// Typed loosely: inside the generic `blockOf` zod cannot prove `tag` is present.
const notItself = (block: { tag?: string; depends_on?: string[] }) => !block.tag || !(block.depends_on ?? []).includes(block.tag);
const NOT_ITSELF = { message: 'a block cannot depend on itself' };

/** What every block has, around its own fields — the twin of `_BlockSpec`. */
const blockOf = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object({ tag, depends_on: z.array(tag).optional(), ...shape })
    .strict()
    .refine(notItself, NOT_ITSELF);

const SCHEMAS = {
  statements: blockOf({ statements: z.array(statement).min(1), requirements: z.array(requirement).optional() }),
  test_debug: blockOf({
    sites: z.array(site).optional(),
    proven: z.string().nullish(),
    statements: z.array(statement).min(1),
  }),
};

/** A test the rules are bound to: the same row a `breadcrumb` block holds. */
export type LwSite = BreadcrumbSite;

/** A file a statement is about, relative to the project root. */
export type LwFileRef = Omit<BreadcrumbSite, 'note'>;

export interface LwStatement {
  text: string;
  basis?: 'stated' | 'proven';
  /** What in today's code violates the statement. Empty means it passes. */
  issues: string[];
  about: LwFileRef[];
}

/** Normalized form the renderers draw from. */
export interface LwBlock {
  kind: LwBlockKind;
  tag: string;
  dependsOn: string[];
  statements: LwStatement[];
  requirements: string[];
  /** `test_debug` only: the bound tests, and when the rules were proven. */
  sites: LwSite[];
  proven?: string;
}

/** Validate an already-parsed block body. Throws `<path>: <message>` on the first problem. */
export function validateLwBlock(kind: LwBlockKind, raw: unknown): LwBlock {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`A ${kind} block must be a YAML mapping with a \`tag\` and a \`statements\` list`);
  }
  const result = SCHEMAS[kind].safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join('.');
    throw new Error(path ? `${path}: ${issue.message}` : issue.message);
  }
  const data = result.data as {
    tag: string;
    depends_on?: string[];
    statements?: z.infer<typeof statement>[];
    requirements?: z.infer<typeof requirement>[];
    sites?: z.infer<typeof site>[];
    proven?: string | null;
  };
  return {
    kind,
    tag: data.tag,
    dependsOn: data.depends_on ?? [],
    statements: (data.statements ?? []).map((s) => ({
      text: s.text,
      basis: s.basis,
      issues: s.issues ?? [],
      about: (s.about ?? []).map(splitAbout),
    })),
    requirements: (data.requirements ?? []).map((r) => r.text),
    sites: (data.sites ?? []).map((x) => ({ relPath: x.rel_path, line: x.line ?? undefined, note: x.note ?? undefined })),
    proven: data.proven ?? undefined,
  };
}

/** Parse and validate a block's YAML source. */
export function parseLwBlock(kind: LwBlockKind, source: string): LwBlock {
  if (!source.trim()) throw new Error(`Empty ${kind} block`);
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    throw new Error(`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateLwBlock(kind, raw);
}
