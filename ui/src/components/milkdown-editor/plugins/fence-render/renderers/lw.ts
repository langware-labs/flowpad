import { t } from '@lingui/core/macro';
/**
 * The lw (langware) blocks of a statement doc render as cards (`docs/lw.md`).
 *
 * - `statements`: the block's tag, the tags it depends on, and one row per
 *   statement — its sentence, whether it was stated or proven, and either
 *   "pass" or the issues that violate it today.
 * - `requirements`: the statements it implements and its requirements.
 * - `test_debug` (what tagit writes in a rules doc): the tag, when the rules
 *   were proven, what they depend on and the tests they are bound to, then the
 *   rules as statements.
 *
 * Read-only by design. A block is written by `flow tag put` (the `langit` and
 * `tagit` skills), which checks it against every other block of the project;
 * an edit typed into a card could not be checked that way, so the Code tab
 * stays the only place to change the text by hand.
 *
 * Everything a statements or requirements card shows is in the block. A
 * `test_debug` card also asks the tag index where its bound tests are now.
 */

import { registerFenceRenderer, type FenceRenderContext, type FenceRenderer } from '../registry';
import { ensureBreadcrumbContext, peekBreadcrumbContext } from './breadcrumb-context';
import { formatSiteLabel } from './breadcrumb-schema';
import { el } from './dom';
import { parseLwBlock, type LwBlock, type LwBlockKind, type LwSite, type LwStatement } from './lw-schema';
import { chipRow, siteChip } from './site-chip';
import { resolveRelPath } from './source-location';

function section(label: string, body: HTMLElement): HTMLElement {
  const wrap = el('div', 'lw-card-section');
  wrap.appendChild(el('div', 'lw-card-label', label));
  wrap.appendChild(body);
  return wrap;
}

function tagLabel(className: string, tag: string): HTMLElement {
  const label = el('span', className, tag);
  label.setAttribute('data-testid', 'lw-tag');
  return label;
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

function statementRow(statement: LwStatement, root: string | null, ctx: FenceRenderContext): HTMLElement {
  const row = el('div', 'lw-card-row');
  row.setAttribute('data-testid', 'lw-statement');

  const head = el('div', 'lw-card-row-head');
  head.appendChild(el('span', 'lw-card-text', statement.text));
  const badges = el('span', 'lw-card-badges');
  if (statement.basis) badges.appendChild(el('span', 'lw-card-badge', statement.basis === 'proven' ? t`proven` : t`stated`));
  const count = statement.issues.length;
  const verdict = el('span', 'lw-card-badge', count === 0 ? t`pass` : count === 1 ? t`1 issue` : t`${count} issues`);
  verdict.setAttribute('data-testid', 'lw-verdict');
  verdict.setAttribute('data-verdict', count === 0 ? 'pass' : 'issues');
  badges.appendChild(verdict);
  head.appendChild(badges);
  row.appendChild(head);

  statement.issues.forEach((issue) => {
    const line = el('div', 'lw-card-issue');
    line.setAttribute('data-testid', 'lw-issue');
    line.appendChild(el('span', 'lw-card-issue-label', t`issue`));
    line.appendChild(el('span', 'lw-card-issue-text', issue));
    row.appendChild(line);
  });

  if (statement.about.length) {
    const files = el('div', 'lw-card-chips');
    statement.about.forEach((file) =>
      files.appendChild(siteChip('lw-file', formatSiteLabel(file), resolveRelPath(file.relPath, root, file.line), ctx)),
    );
    row.appendChild(files);
  }
  return row;
}

function statementsSection(block: LwBlock, root: string | null, ctx: FenceRenderContext): HTMLElement {
  const rows = el('div', 'lw-card-rows');
  block.statements.forEach((statement) => rows.appendChild(statementRow(statement, root, ctx)));
  return section(t`Statements`, rows);
}

function buildCard(block: LwBlock, root: string | null, ctx: FenceRenderContext): HTMLElement {
  const card = el('div', 'lw-card');
  card.setAttribute('data-testid', `lw-${block.kind}-card`);

  const header = el('div', 'lw-card-header');
  header.appendChild(tagLabel('lw-card-tag', block.tag));
  card.appendChild(header);

  const implementing = block.kind === 'requirements';
  if (block.dependsOn.length) card.appendChild(dependsOn(implementing ? t`Implements` : t`Depends on`, block.dependsOn));

  if (!implementing) {
    card.appendChild(statementsSection(block, root, ctx));
    return card;
  }
  const rows = el('div', 'lw-card-rows');
  block.requirements.forEach((text) => {
    const row = el('div', 'lw-card-row');
    row.setAttribute('data-testid', 'lw-requirement');
    row.appendChild(el('span', 'lw-card-text', text));
    rows.appendChild(row);
  });
  card.appendChild(section(t`Requirements`, rows));
  return card;
}

function buildTestDebug(block: LwBlock, sites: LwSite[], root: string | null, ctx: FenceRenderContext): HTMLElement {
  const wrap = el('div', 'test-debug');
  wrap.setAttribute('data-testid', 'lw-test_debug-card');

  const card = el('div', 'breadcrumb-card');
  const header = el('div', 'breadcrumb-card-header');
  header.appendChild(tagLabel('breadcrumb-card-tag', block.tag));
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
  rules.appendChild(statementsSection(block, root, ctx));
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
 * Throws on a block that does not match its schema; the NodeView turns that
 * into an inline chip and keeps whatever was rendered last.
 *
 * @internal exported for tests, which need the card without a NodeView.
 */
export function renderLwCard(kind: LwBlockKind, code: string, host: HTMLElement, ctx: FenceRenderContext): void {
  host.replaceChildren(buildCard(parseLwBlock(kind, code), ctx.host.documentProjectRoot(), ctx));
}

/** One renderer per block kind: its fence language, its tab label, how it draws. */
const RENDERERS: FenceRenderer[] = [
  { language: 'statements', tabLabel: 'Statements', layout: 'block', render: (c, h, x) => renderLwCard('statements', c, h, x) },
  { language: 'requirements', tabLabel: 'Requirements', layout: 'block', render: (c, h, x) => renderLwCard('requirements', c, h, x) },
  { language: 'test_debug', tabLabel: 'Test debug', layout: 'block', render: renderTestDebugCard },
];

RENDERERS.forEach(registerFenceRenderer);
