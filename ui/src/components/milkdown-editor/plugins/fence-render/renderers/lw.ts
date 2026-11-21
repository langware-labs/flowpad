import { t } from '@lingui/core/macro';
/**
 * The lw (langware) blocks of a statement doc render as cards (`docs/lw.md`).
 *
 * - `statements`: one row per statement — its sentence, and whether it was
 *   stated or proven. What violates the statements today is the block's Issues
 *   tab, and the files they are about its References tab; each exists only
 *   when the block has any, and carries a counter.
 * - `requirements`: the statements it implements and its requirements.
 * - `test_debug` (what tagit writes in a rules doc): the tag, when the rules
 *   were proven, what they depend on and the tests they are bound to, then the
 *   rules as statements.
 *
 * A statements or requirements block's tag is drawn by the host, as a chip at
 * the end of the tab row (`chrome`), so the card has no header line.
 *
 * In an editable host a statement's sentence is click-to-edit: the typed text
 * goes into the block's YAML as it is (`lw-edit.ts`). A sentence cannot break a
 * tag or a dependency, so it needs no check against the rest of the project.
 * Everything else — tags, dependencies, issues, files — is written by
 * `flow tag put` (the `langit` and `tagit` skills), which does that check, or
 * by hand on the Code tab.
 *
 * Everything a statements or requirements card shows is in the block. A
 * `test_debug` card also asks the tag index where its bound tests are now.
 */

import { registerFenceRenderer, type FenceChrome, type FenceRenderContext, type FenceRenderer } from '../registry';
import { ensureBreadcrumbContext, peekBreadcrumbContext } from './breadcrumb-context';
import { formatSiteLabel } from './breadcrumb-schema';
import { editable, el } from './dom';
import { applyLwEdit } from './lw-edit';
import {
  parseLwBlock,
  type LwBlock,
  type LwBlockKind,
  type LwFileRef,
  type LwSite,
  type LwStatement,
} from './lw-schema';
import { chipRow, siteChip } from './site-chip';
import { resolveRelPath } from './source-location';

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

function issueLine(issue: string, labelled: boolean): HTMLElement {
  const line = el('div', 'lw-card-issue');
  line.setAttribute('data-testid', 'lw-issue');
  if (labelled) line.appendChild(el('span', 'lw-card-issue-label', t`issue`));
  line.appendChild(el('span', 'lw-card-issue-text', issue));
  return line;
}

/** One row of a card: a sentence, its badges, and whatever is listed under it. */
function row(testId: string, text: HTMLElement, badges: (HTMLElement | null)[], body: HTMLElement[] = []): HTMLElement {
  const node = el('div', 'lw-card-row');
  node.setAttribute('data-testid', testId);
  const head = el('div', 'lw-card-row-head');
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
const VIEW = { issues: 'issues', references: 'references' } as const;

/** The Issues view: each violated statement, with its issues under it. */
function issuesView(block: LwBlock): HTMLElement {
  const rows = block.statements
    .filter((statement) => statement.issues.length)
    .map((statement) =>
      row(
        'lw-issues-of',
        el('span', 'lw-card-text lw-card-text-strong', statement.text),
        [verdictBadge(statement.issues.length)],
        statement.issues.map((issue) => issueLine(issue, false)),
      ),
    );
  return rowsSection(t`Issues`, rows);
}

/** The References view: each statement that names files, with a chip per file. */
function referencesView(block: LwBlock, root: string | null, ctx: FenceRenderContext): HTMLElement {
  const rows = block.statements
    .filter((statement) => statement.about.length)
    .map((statement) =>
      row('lw-references-of', el('span', 'lw-card-text lw-card-text-strong', statement.text), [], [
        fileChips(statement, root, ctx),
      ]),
    );
  return rowsSection(t`References`, rows);
}

/** The Statements view: each sentence (click-to-edit in an editable host) and its basis. */
function statementsView(block: LwBlock, ctx: FenceRenderContext, edit: (statement: number, text: string) => void): HTMLElement {
  const rows = block.statements.map((statement, index) =>
    row(
      'lw-statement',
      editable('lw-card-text', statement.text, `lw-statement-text-${index}`, ctx.editable, (text) => edit(index, text)),
      [basisBadge(statement)],
    ),
  );
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
  edit: (statement: number, text: string) => void,
): HTMLElement {
  const root = ctx.host.documentProjectRoot();
  const card = el('div', 'lw-card');
  card.setAttribute('data-testid', `lw-${block.kind}-card`);

  if (ctx.view === VIEW.issues) card.appendChild(issuesView(block));
  else if (ctx.view === VIEW.references) card.appendChild(referencesView(block, root, ctx));
  else {
    const implementing = block.kind === 'requirements';
    if (block.dependsOn.length) card.appendChild(dependsOn(implementing ? t`Implements` : t`Depends on`, block.dependsOn));
    if (implementing) {
      const rows = block.requirements.map((text) => {
        const node = el('div', 'lw-card-row');
        node.setAttribute('data-testid', 'lw-requirement');
        node.appendChild(el('span', 'lw-card-text', text));
        return node;
      });
      card.appendChild(rowsSection(t`Requirements`, rows));
    } else {
      card.appendChild(statementsView(block, ctx, edit));
    }
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
  const edit = (statement: number, text: string) => {
    const next = applyLwEdit(source, { statement, text });
    if (next === source) return;
    ctx.commit(next);
    draw(kind, next, host, ctx);
  };
  host.replaceChildren(buildCard(parse(kind, source), ctx, edit));
}

/** @internal exported for tests, which need the card without a NodeView. */
export function renderLwCard(kind: LwBlockKind, code: string, host: HTMLElement, ctx: FenceRenderContext): void {
  draw(kind, code, host, ctx);
}

/**
 * The block's tab row: its tag, an Issues tab when something is violated and a
 * References tab when a statement names a file — each with its count.
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
  return { tag: block.tag, views };
}

const card = (kind: LwBlockKind, tabLabel: string): FenceRenderer => ({
  language: kind,
  tabLabel,
  layout: 'block',
  render: (code, host, ctx) => renderLwCard(kind, code, host, ctx),
  chrome: (code) => lwChrome(kind, code),
});

/** One renderer per block kind: its fence language, its tab label, how it draws. */
const RENDERERS: FenceRenderer[] = [
  card('statements', 'Statements'),
  card('requirements', 'Requirements'),
  { language: 'test_debug', tabLabel: 'Test debug', layout: 'block', render: renderTestDebugCard },
];

RENDERERS.forEach(registerFenceRenderer);
