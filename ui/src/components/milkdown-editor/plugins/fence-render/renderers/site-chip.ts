import { t } from '@lingui/core/macro';
/**
 * A chip that peeks at a file, and the row a bound test is drawn as. Shared by
 * the `breadcrumb` card and the lw cards (`lw.ts`), which point at files the
 * same way.
 */
import { FileCode } from 'lucide-react';

import type { FenceRenderContext } from '../registry';
import { el, iconMarkup } from './dom';
import type { SourceLocation } from './source-location';

const SITE_ICON = iconMarkup(FileCode);

/**
 * Deliberately NOT gated on `ctx.editable`. A chip mutates nothing, and a
 * read-only surface — the vibe display, a `view`-mode asset — is exactly where
 * following it to the file matters most.
 */
export function siteChip(testId: string, label: string, location: SourceLocation, ctx: FenceRenderContext): HTMLElement {
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
  return chip;
}

/** One row: a chip, and whatever note goes with it. */
export function chipRow(
  testId: string,
  label: string,
  location: SourceLocation,
  note: string | undefined,
  ctx: FenceRenderContext,
): HTMLElement {
  const row = el('div', 'breadcrumb-card-site');
  row.appendChild(siteChip(testId, label, location, ctx));

  // The note is the whole payload `flow tag get` shows for a code site, so it
  // is shown in full rather than behind the chip's tooltip.
  if (note) row.appendChild(el('span', 'breadcrumb-card-site-note', note));
  return row;
}

