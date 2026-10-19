import { i18n } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
/**
 * ```breadcrumb fences render as a card of the tests a rules doc governs.
 *
 * The `tagit` skill writes one of these into `docs/breadcrumbs/<slug>.md` next
 * to the `tag` capsule it drops on the failing test. Clicking a site peeks at
 * that test, at the capsule's line — the same `FilePreviewSheet` the interface
 * card's source chip opens.
 *
 * **Hybrid by design.** The block carries the sites the skill knew about, so
 * the card is useful with no backend at all; the tag index is then asked what
 * is bound *now*, and its answer wins. The authored list is a cache of
 * something the index owns, which is why it is never treated as authoritative
 * and never blanks the card when it disagrees.
 *
 * `render` is deliberately synchronous — see `breadcrumb-context.ts` for why
 * the fetch cannot live in a renderer closure, and why it must never throw.
 */

import { FileCode, RefreshCw } from 'lucide-react';

import { registerFenceRenderer, type FenceRenderContext, type FenceRenderer } from '../registry';
import { ensureBreadcrumbContext, invalidateBreadcrumbContext, peekBreadcrumbContext } from './breadcrumb-context';
import { formatSiteLabel, parseBreadcrumbBlock, type BreadcrumbSite, type BreadcrumbSpec } from './breadcrumb-schema';
import { el, iconMarkup } from './dom';
import { resolveRelPath, type SourceLocation } from './source-location';

const SITE_ICON = iconMarkup(FileCode);
const REFRESH_ICON = iconMarkup(RefreshCw);

/**
 * Where the rows on screen came from.
 *
 * `authored` — the block's own `sites:`; `pending` — same rows, a join in
 * flight; `live` — the tag index answered; `stale` — a live answer is being
 * shown but the most recent refresh failed.
 */
type Provenance = 'authored' | 'pending' | 'live' | 'stale';

/** Label and tooltip kept in one table so a new state cannot get half of it. */
const PROVENANCE: Record<Provenance, { label: MessageDescriptor | null; title: MessageDescriptor }> = {
  authored: { label: msg`authored`, title: msg`From this block's own sites list` },
  // `pending` shows no label, only a tooltip — null rather than an empty
  // `msg`, which would be an invalid (empty) message id.
  pending: { label: null, title: msg`Checking the tag index…` },
  live: { label: msg`live`, title: msg`From the tag index` },
  stale: { label: msg`live · stale`, title: msg`From the tag index; the last refresh failed` },
};

/** What to draw, resolved from the block and whatever the cache knows. */
interface CardState {
  rows: BreadcrumbSite[];
  provenance: Provenance;
  /** Set when the join failed and there is no live answer to fall back on. */
  status: string | null;
}

function cardState(spec: BreadcrumbSpec, root: string | null): CardState {
  const entry = root ? peekBreadcrumbContext(spec.tag, root) : undefined;
  if (!entry) return { rows: spec.sites, provenance: 'authored', status: null };
  // A live answer, once obtained, keeps being shown while a refresh is in
  // flight — repainting back to the authored rows and forward again would
  // flicker for no information gain.
  if (entry.sites) return { rows: entry.sites, provenance: entry.error ? 'stale' : 'live', status: null };
  if (entry.inFlight) return { rows: spec.sites, provenance: 'pending', status: null };
  return { rows: spec.sites, provenance: 'authored', status: entry.error };
}

/**
 * One row: a chip that peeks at a file, and whatever note goes with it.
 *
 * Deliberately NOT gated on `ctx.editable`. Nothing on this card mutates the
 * document, and a read-only surface — the vibe display, a `view`-mode asset —
 * is exactly where following a breadcrumb to its test matters most.
 */
function chipRow(
  testId: string,
  label: string,
  location: SourceLocation,
  note: string | undefined,
  ctx: FenceRenderContext,
): HTMLElement {
  const row = el('div', 'breadcrumb-card-site');

  const chip = el('button', 'breadcrumb-card-site-chip');
  chip.type = 'button';
  chip.setAttribute('data-testid', testId);
  chip.innerHTML = SITE_ICON;
  chip.appendChild(el('span', 'breadcrumb-card-site-label', label));

  if (location.ok) {
    chip.title = t`Preview ${location.path}`;
    chip.addEventListener('click', () => {
      ctx.host.previewFile(location.path, { line: location.line });
    });
  } else {
    // A dead chip that says nothing is worse than none — carry the resolver's
    // own reason, the way the interface source chip does.
    chip.disabled = true;
    chip.title = location.reason;
    chip.setAttribute('data-reason', location.reason);
  }
  row.appendChild(chip);

  // The note is the whole payload `flow tag get` shows for a code site, so it
  // is shown in full rather than behind the chip's tooltip.
  if (note) row.appendChild(el('span', 'breadcrumb-card-site-note', note));
  return row;
}

function buildCard(
  spec: BreadcrumbSpec,
  state: CardState,
  root: string | null,
  ctx: FenceRenderContext,
  refresh: (() => void) | null,
): HTMLElement {
  const card = el('div', 'breadcrumb-card');
  card.setAttribute('data-testid', 'breadcrumb-card');

  const header = el('div', 'breadcrumb-card-header');
  const tag = el('span', 'breadcrumb-card-tag', spec.tag);
  tag.setAttribute('data-testid', 'breadcrumb-tag');
  header.appendChild(tag);

  const provenanceLabel = PROVENANCE[state.provenance].label;
  const provenance = el('span', 'breadcrumb-card-provenance', provenanceLabel ? i18n._(provenanceLabel) : '');
  provenance.setAttribute('data-testid', 'breadcrumb-provenance');
  provenance.setAttribute('data-provenance', state.provenance);
  provenance.title = i18n._(PROVENANCE[state.provenance].title);
  header.appendChild(provenance);

  if (refresh) {
    const button = el('button', 'breadcrumb-card-refresh');
    button.type = 'button';
    button.setAttribute('data-testid', 'breadcrumb-refresh');
    button.setAttribute('aria-label', 'Refresh from the tag index');
    button.title = t`Refresh from the tag index`;
    button.innerHTML = REFRESH_ICON;
    button.addEventListener('click', refresh);
    header.appendChild(button);
  }
  card.appendChild(header);

  const sites = el('div', 'breadcrumb-card-sites');
  state.rows.forEach((site, index) =>
    sites.appendChild(
      chipRow(
        `breadcrumb-site-${index}`,
        formatSiteLabel(site),
        resolveRelPath(site.relPath, root, site.line),
        site.note,
        ctx,
      ),
    ),
  );
  // Issues belong to the authored block, so they are shown alongside whichever
  // rows won — a malformed row is a defect in the doc either way.
  spec.issues.forEach((issue) =>
    sites.appendChild(
      chipRow(
        `breadcrumb-issue-${issue.index}`,
        `sites[${issue.index}]`,
        { ok: false, reason: issue.reason },
        undefined,
        ctx,
      ),
    ),
  );
  card.appendChild(sites);

  if (!state.rows.length && !spec.issues.length) {
    const empty = el('div', 'breadcrumb-card-empty', 'No bound tests');
    empty.setAttribute('data-testid', 'breadcrumb-empty');
    card.appendChild(empty);
  }

  if (state.status) {
    // NOT the NodeView's error chip: that one means "your source is wrong", and
    // a backend that is down is not the author's fault.
    const status = el('div', 'breadcrumb-card-status', `Tag index unavailable — ${state.status}`);
    status.setAttribute('data-testid', 'breadcrumb-status');
    card.appendChild(status);
  }

  return card;
}

/**
 * Draw the card, then ask the index and redraw if it answers.
 *
 * Order matters: `ensureBreadcrumbContext` is called BEFORE the first paint so
 * a cold block can show that a lookup is in flight. It returns immediately —
 * only the repaint is deferred — so the authored rows are on screen before the
 * network is touched.
 *
 * The repaint is guarded on `host.isConnected`. The NodeView attaches `host`
 * only after a successful render, so a superseded render's host stays detached
 * forever and its callback becomes a no-op. That is what makes a one-shot
 * callback safe where `FenceRenderer`, having no teardown hook, could not
 * safely hold a subscription.
 *
 * @internal exported for tests, which need the card without a NodeView.
 */
export function renderBreadcrumbCard(code: string, host: HTMLElement, ctx: FenceRenderContext): void {
  const spec = parseBreadcrumbBlock(code);
  const root = ctx.host.documentProjectRoot();

  let refresh: (() => void) | null = null;
  const paint = () => host.replaceChildren(buildCard(spec, cardState(spec, root), root, ctx, refresh));
  const repaint = () => {
    if (host.isConnected) paint();
  };

  // Without a project root there is nothing to resolve a rel_path against, and
  // the route only answers the `code` half when it is given one — so the whole
  // live path is skipped rather than paid for and discarded.
  if (root) {
    refresh = () => {
      invalidateBreadcrumbContext(spec.tag, root);
      ensureBreadcrumbContext(spec.tag, root, repaint);
      repaint();
    };
    ensureBreadcrumbContext(spec.tag, root, repaint);
  }
  paint();
}

export const breadcrumbRenderer: FenceRenderer = {
  language: 'breadcrumb',
  tabLabel: 'Breadcrumb',
  // A list of bound tests is document-width content, not a centred figure.
  layout: 'block',

  render(code, host, ctx) {
    // Throws only on a block with no identity; the NodeView turns that into an
    // inline chip and keeps whatever was rendered last.
    renderBreadcrumbCard(code, host, ctx);
  },
};

registerFenceRenderer(breadcrumbRenderer);
