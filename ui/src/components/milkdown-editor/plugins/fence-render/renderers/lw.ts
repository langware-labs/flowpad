import { t } from '@lingui/core/macro';
/**
 * The lw (langware) blocks of a statement doc render as cards (`docs/lw.md`).
 *
 * - `statements`: one numbered row per statement — its sentence, and whether
 *   it was stated or proven. What violates the statements today is the block's
 *   Issues tab, the files they are about its References tab, and what must be
 *   built its Requirements tab; each exists only when the block has any, and
 *   carries a counter.
 * - `test_debug` (what tagit writes in a rules doc): the tag, when the rules
 *   were proven, what they depend on and the tests they are bound to, then the
 *   rules as statements.
 *
 * A statements block's tag is drawn by the host, as a chip at
 * the end of the tab row (`chrome`), so the card has no header line.
 *
 * In an editable host a statement's sentence is click-to-edit: the typed text,
 * which may run over several lines, goes into the block's YAML as it is
 * (`lw-edit.ts`), and statements can be added and deleted there. A sentence cannot break a
 * tag or a dependency, so it needs no check against the rest of the project.
 * Everything else — tags, dependencies, issues, files — is written by
 * `flow tag put` (the `langit` and `tagit` skills), which does that check, or
 * by hand on the Code tab.
 *
 * Everything a statements card shows is in the block. A
 * `test_debug` card also asks the tag index where its bound tests are now.
 */

import { Plus, Trash2 } from 'lucide-react';

import { registerFenceRenderer, type FenceChrome, type FenceRenderContext, type FenceRenderer } from '../registry';
import { ensureBreadcrumbContext, peekBreadcrumbContext } from './breadcrumb-context';
import { formatSiteLabel } from './breadcrumb-schema';
import { editable, el, iconMarkup } from './dom';
import { applyLwEdit, type LwEdit } from './lw-edit';
import {
  parseLwBlock,
  type LwBlock,
  type LwBlockKind,
  type LwFileRef,
  type LwSite,
  type LwStatement,
  splitAbout,
} from './lw-schema';
import { chipRow, siteChip } from './site-chip';
import { resolveRelPath } from './source-location';

const ADD_ICON = iconMarkup(Plus);
const DELETE_ICON = iconMarkup(Trash2);

function section(label: string, body: HTMLElement): HTMLElement {
  const wrap = el('div', 'lw-card-section');
  wrap.appendChild(el('div', 'lw-card-label', label));
  wrap.appendChild(body);
  return wrap;
}

function dependsOn(label: string, tags: string[]): HTMLElement {
  const row = el('div', 'lw-card-chips');
  tags.forEach((name) => {
    const chip = el('span', 'lw-card-tag-chip', name);
    chip.setAttribute('data-testid', 'lw-depends-on');
    row.appendChild(chip);
  });
  return section(label, row);
}

function fileChip(file: LwFileRef, root: string | null, ctx: FenceRenderContext): HTMLElement {
  return siteChip('lw-file', formatSiteLabel(file), resolveRelPath(file.relPath, root, file.line), ctx);
}

function fileChips(statement: LwStatement, root: string | null, ctx: FenceRenderContext): HTMLElement {
  const chips = el('div', 'lw-card-chips');
  statement.about.forEach((file) => chips.appendChild(fileChip(file, root, ctx)));
  return chips;
}

function basisBadge(statement: LwStatement): HTMLElement | null {
  return statement.basis ? el('span', 'lw-card-badge', statement.basis === 'proven' ? t`proven` : t`stated`) : null;
}

/** "pass", or how many issues. */
function verdictBadge(count: number): HTMLElement {
  const badge = el('span', 'lw-card-badge', count === 0 ? t`pass` : count === 1 ? t`1 issue` : t`${count} issues`);
  badge.setAttribute('data-testid', 'lw-verdict');
  badge.setAttribute('data-verdict', count === 0 ? 'pass' : 'issues');
  return badge;
}

/** A file location written inside a sentence: `flow_sdk/utils/machine_id.py:29`. At least one folder, so a bare `a.b` is not one. */
const LOCATION = /(?:[\w.@-]+\/)+[\w@-]+\.\w+(?::\d+)?/g;

/**
 * An issue's sentence with each file location in it drawn as a chip: the file's
 * name (and line), the whole path on hover, a click previews the file there.
 */
function issueText(issue: string, root: string | null, ctx: FenceRenderContext): HTMLElement {
  const text = el('span', 'lw-card-issue-text');
  let at = 0;
  for (const found of issue.matchAll(LOCATION)) {
    const file = splitAbout(found[0]);
    text.append(issue.slice(at, found.index));
    const name = file.relPath.split('/').at(-1)!;
    const chip = siteChip('lw-location', formatSiteLabel({ ...file, relPath: name }), resolveRelPath(file.relPath, root, file.line), ctx);
    chip.title = found[0];
    text.appendChild(chip);
    at = found.index + found[0].length;
  }
  text.append(issue.slice(at));
  return text;
}

/** One issue. `locations` (the Issues tab) draws the files it names as chips. */
function issueLine(issue: string, labelled: boolean, locations?: { root: string | null; ctx: FenceRenderContext }): HTMLElement {
  const line = el('div', 'lw-card-issue');
  line.setAttribute('data-testid', 'lw-issue');
  if (labelled) line.appendChild(el('span', 'lw-card-issue-label', t`issue`));
  line.appendChild(locations ? issueText(issue, locations.root, locations.ctx) : el('span', 'lw-card-issue-text', issue));
  return line;
}

/**
 * One row of a card: a sentence, its badges, and whatever is listed under it.
 * `number` is the statement's place in its block (a statement has no id): the
 * same number names it on the Statements, Issues and References tabs.
 */
function row(
  testId: string,
  text: HTMLElement,
  badges: (HTMLElement | null)[],
  body: HTMLElement[] = [],
  number?: number,
): HTMLElement {
  const node = el('div', 'lw-card-row');
  node.setAttribute('data-testid', testId);
  const head = el('div', 'lw-card-row-head');
  if (number != null) {
    const chip = el('span', 'lw-card-number', String(number));
    chip.setAttribute('data-testid', 'lw-number');
    head.appendChild(chip);
  }
  head.appendChild(text);
  const shown = badges.filter((badge): badge is HTMLElement => badge != null);
  if (shown.length) {
    const wrap = el('span', 'lw-card-badges');
    shown.forEach((badge) => wrap.appendChild(badge));
    head.appendChild(wrap);
  }
  node.appendChild(head);
  body.forEach((child) => node.appendChild(child));
  return node;
}

function rowsSection(label: string, rows: HTMLElement[]): HTMLElement {
  const list = el('div', 'lw-card-rows');
  rows.forEach((node) => list.appendChild(node));
  return section(label, list);
}

/** The extra views of a statements block: what is violated, and the files it is about. */
const VIEW = { issues: 'issues', references: 'references', requirements: 'requirements' } as const;

/** The statements of a block with their numbers, so a filtered list keeps them. */
const numbered = (block: LwBlock) => block.statements.map((statement, index) => ({ statement, number: index + 1 }));

/** The Issues view: each violated statement, with its issues under it. */
function issuesView(block: LwBlock, root: string | null, ctx: FenceRenderContext): HTMLElement {
  const rows = numbered(block)
    .filter(({ statement }) => statement.issues.length)
    .map(({ statement, number }) =>
      row(
        'lw-issues-of',
        el('span', 'lw-card-text lw-card-text-strong', statement.text),
        [verdictBadge(statement.issues.length)],
        statement.issues.map((issue) => issueLine(issue, false, { root, ctx })),
        number,
      ),
    );
  return rowsSection(t`Issues`, rows);
}

/** The References view: each statement that names files, with a chip per file. */
function referencesView(block: LwBlock, root: string | null, ctx: FenceRenderContext): HTMLElement {
  const rows = numbered(block)
    .filter(({ statement }) => statement.about.length)
    .map(({ statement, number }) =>
      row(
        'lw-references-of',
        el('span', 'lw-card-text lw-card-text-strong', statement.text),
        [],
        [fileChips(statement, root, ctx)],
        number,
      ),
    );
  return rowsSection(t`References`, rows);
}

/** The Requirements view: what must be built to make the block's statements true. */
function requirementsView(block: LwBlock): HTMLElement {
  return rowsSection(
    t`Requirements`,
    block.requirements.map((text) => row('lw-requirement', el('span', 'lw-card-text', text), [])),
  );
}

/**
 * The Statements view: each sentence and its basis. In an editable host a
 * sentence is click-to-edit, each statement can be deleted (while more than one
 * is left) and a row at the end adds one.
 */
function statementsView(block: LwBlock, ctx: FenceRenderContext, edit: (change: LwEdit) => void): HTMLElement {
  const deletable = ctx.editable && block.statements.length > 1;
  const rows = block.statements.map((statement, index) => {
    const node = row(
      'lw-statement',
      editable(
        'lw-card-text',
        statement.text,
        `lw-statement-text-${index}`,
        ctx.editable,
        (text) => edit({ kind: 'text', statement: index, text }),
        { multiline: true },
      ),
      [basisBadge(statement)],
      [],
      index + 1,
    );
    if (deletable) {
      const remove = el('button', 'lw-card-delete');
      remove.type = 'button';
      remove.setAttribute('data-testid', `lw-statement-delete-${index}`);
      remove.setAttribute('aria-label', t`Delete statement ${index + 1}`);
      remove.title = t`Delete this statement`;
      remove.innerHTML = DELETE_ICON;
      remove.addEventListener('click', () => edit({ kind: 'delete', statement: index }));
      node.firstElementChild!.appendChild(remove);
    }
    return node;
  });
  if (ctx.editable) {
    const add = el('button', 'lw-card-add');
    add.type = 'button';
    add.setAttribute('data-testid', 'lw-statement-add');
    add.innerHTML = ADD_ICON;
    add.appendChild(el('span', '', t`Add statement`));
    add.addEventListener('click', () => edit({ kind: 'add', text: t`New statement` }));
    rows.push(add);
  }
  return rowsSection(t`Statements`, rows);
}

/** The rules of a `test_debug` card: each sentence with pass or its issues, and its files, in one list. */
function rulesSection(block: LwBlock, root: string | null, ctx: FenceRenderContext): HTMLElement {
  const rows = block.statements.map((statement) =>
    row(
      'lw-statement',
      el('span', 'lw-card-text', statement.text),
      [basisBadge(statement), verdictBadge(statement.issues.length)],
      [
        ...statement.issues.map((issue) => issueLine(issue, true)),
        ...(statement.about.length ? [fileChips(statement, root, ctx)] : []),
      ],
    ),
  );
  return rowsSection(t`Statements`, rows);
}

function buildCard(
  block: LwBlock,
  ctx: FenceRenderContext,
  edit: (change: LwEdit) => void,
): HTMLElement {
  const root = ctx.host.documentProjectRoot();
  const card = el('div', 'lw-card');
  card.setAttribute('data-testid', `lw-${block.kind}-card`);

  if (ctx.view === VIEW.issues) card.appendChild(issuesView(block, root, ctx));
  else if (ctx.view === VIEW.references) card.appendChild(referencesView(block, root, ctx));
  else if (ctx.view === VIEW.requirements) card.appendChild(requirementsView(block));
  else {
    if (block.dependsOn.length) card.appendChild(dependsOn(t`Depends on`, block.dependsOn));
    card.appendChild(statementsView(block, ctx, edit));
  }
  return card;
}

function buildTestDebug(block: LwBlock, sites: LwSite[], root: string | null, ctx: FenceRenderContext): HTMLElement {
  const wrap = el('div', 'test-debug');
  wrap.setAttribute('data-testid', 'lw-test_debug-card');

  const card = el('div', 'breadcrumb-card');
  const header = el('div', 'breadcrumb-card-header');
  const tag = el('span', 'breadcrumb-card-tag', block.tag);
  tag.setAttribute('data-testid', 'lw-tag');
  header.appendChild(tag);
  if (block.proven) {
    const proven = el('span', 'breadcrumb-card-provenance', t`proven ${block.proven}`);
    proven.setAttribute('data-testid', 'lw-proven');
    header.appendChild(proven);
  }
  card.appendChild(header);
  if (block.dependsOn.length) card.appendChild(dependsOn(t`Depends on`, block.dependsOn));
  if (sites.length) {
    const rows = el('div', 'breadcrumb-card-sites');
    sites.forEach((site, index) =>
      rows.appendChild(
        chipRow(`lw-site-${index}`, formatSiteLabel(site), resolveRelPath(site.relPath, root, site.line), site.note, ctx),
      ),
    );
    card.appendChild(rows);
  }
  wrap.appendChild(card);

  const rules = el('div', 'lw-card');
  rules.appendChild(rulesSection(block, root, ctx));
  wrap.appendChild(rules);
  return wrap;
}

/**
 * The bound tests move as code is edited, so the rows the tag index knows win
 * over the ones written in the block, as on the `breadcrumb` card.
 *
 * @internal exported for tests, which need the card without a NodeView.
 */
export function renderTestDebugCard(code: string, host: HTMLElement, ctx: FenceRenderContext): void {
  const block = parseLwBlock('test_debug', code);
  const root = ctx.host.documentProjectRoot();
  const paint = () => {
    const live = root ? peekBreadcrumbContext(block.tag, root)?.sites : undefined;
    host.replaceChildren(buildTestDebug(block, live?.length ? live : block.sites, root, ctx));
  };
  if (root) {
    ensureBreadcrumbContext(block.tag, root, () => {
      if (host.isConnected) paint();
    });
  }
  paint();
}

/**
 * The block for `source`. The tab row (`lwChrome`) and the card are drawn from
 * the same text one after the other, so the last parse is kept and reused.
 */
let lastParse: { kind: LwBlockKind; source: string; block: LwBlock } | null = null;

function parse(kind: LwBlockKind, source: string): LwBlock {
  if (lastParse?.kind !== kind || lastParse.source !== source) lastParse = { kind, source, block: parseLwBlock(kind, source) };
  return lastParse.block;
}

/**
 * Draw the card for `source`, and redraw it against the new source after an
 * edit of its own: the host skips the re-render its own commit would trigger
 * (so the field keeps focus), and the next edit must start from current text.
 *
 * Throws on a block that does not match its schema; the NodeView turns that
 * into an inline chip and keeps whatever was rendered last.
 */
function draw(kind: LwBlockKind, source: string, host: HTMLElement, ctx: FenceRenderContext): void {
  const edit = (change: LwEdit) => {
    const next = applyLwEdit(source, change);
    if (next === source) return;
    ctx.commit(next);
    draw(kind, next, host, ctx);
    // The delete button is gone with its row: hand focus to the document, so undo reaches the edit.
    if (change.kind === 'delete') ctx.focusDocument?.();
    if (change.kind === 'add') {
      // The new statement is there to be typed over: put the caret in it, all of it selected.
      const fields = host.querySelectorAll<HTMLElement>('[data-testid^="lw-statement-text-"]');
      const field = fields[fields.length - 1];
      field?.focus();
      if (field) field.ownerDocument.getSelection()?.selectAllChildren(field);
    }
  };
  host.replaceChildren(buildCard(parse(kind, source), ctx, edit));
}

/** @internal exported for tests, which need the card without a NodeView. */
export function renderLwCard(kind: LwBlockKind, code: string, host: HTMLElement, ctx: FenceRenderContext): void {
  draw(kind, code, host, ctx);
}

/**
 * The block's tab row: its tag, an Issues tab when something is violated, a
 * References tab when a statement names a file and a Requirements tab when
 * the block has requirements — each with its count.
 *
 * @internal exported for tests.
 */
export function lwChrome(kind: LwBlockKind, code: string): FenceChrome {
  const block = parse(kind, code);
  const issues = block.statements.reduce((n, statement) => n + statement.issues.length, 0);
  const files = block.statements.reduce((n, statement) => n + statement.about.length, 0);
  const views = [];
  if (issues) views.push({ id: VIEW.issues, label: t`Issues`, count: issues, tone: 'warn' as const });
  if (files) views.push({ id: VIEW.references, label: t`References`, count: files });
  if (block.requirements.length) {
    views.push({ id: VIEW.requirements, label: t`Requirements`, count: block.requirements.length });
  }
  return { tag: block.tag, views };
}

/** One renderer per block kind: its fence language, its tab label, how it draws. */
const RENDERERS: FenceRenderer[] = [
  {
    language: 'statements',
    tabLabel: 'Statements',
    layout: 'block',
    render: (code, host, ctx) => renderLwCard('statements', code, host, ctx),
    chrome: (code) => lwChrome('statements', code),
  },
  { language: 'test_debug', tabLabel: 'Test debug', layout: 'block', render: renderTestDebugCard },
];

RENDERERS.forEach(registerFenceRenderer);
