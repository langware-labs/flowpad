/**
 * The tab strip's scanner: the hovered chip shown at full width, in place.
 *
 * With many tabs a chip is 40px of icon, so sliding the pointer along the strip
 * has to read title after title. The label is drawn OVER the strip rather than
 * in it — the chips never move — and it grows backward, over the tabs already
 * passed, so the ones still ahead of the pointer stay visible.
 *
 * It takes no pointer events: the hover zone stays the chip's own narrow slot,
 * and click, drag, rename and the context menu keep landing on the real chips.
 */
import React from 'react';
import { createPortal } from 'react-dom';

export const SCAN_LABEL_MAX_PX = 320;

type ScanChipRect = Pick<DOMRect, 'left' | 'right' | 'top' | 'height'>;

export interface ScanLabelBox {
  /** The fixed slot the label is end-aligned in. */
  slot: React.CSSProperties;
  /** The label never shows less than the part of the chip it stands over. */
  labelMinWidth: number;
}

/**
 * Where the label sits. Its END edge is pinned just before the chip's own close
 * button (`closeSlotPx` wide, 0 when the chip shows none), so label + button
 * read as one tab; the START edge is free and follows the title's width.
 *
 * It stays inside the tab row (`row`). Near the row's start there is no room to
 * grow backward, so the slot starts at the row edge and a long title runs
 * forward instead — a short one still ends at the close button.
 */
export function scanLabelBox(
  chip: ScanChipRect,
  closeSlotPx: number,
  dir: 'ltr' | 'rtl',
  row: { left: number; right: number },
  viewportPx: number,
): ScanLabelBox {
  const rtl = dir === 'rtl';
  const edge = rtl ? chip.left + closeSlotPx : chip.right - closeSlotPx;
  const room = Math.max(0, Math.min(SCAN_LABEL_MAX_PX, rtl ? row.right - edge : edge - row.left));
  const side = rtl ? { right: viewportPx - (edge + room) } : { left: edge - room };
  return {
    slot: { top: chip.top, height: chip.height, minWidth: room, ...side },
    labelMinWidth: Math.max(0, chip.right - chip.left - closeSlotPx),
  };
}

interface TabScanLabelProps {
  box: ScanLabelBox;
  active: boolean;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  title: string;
  titleClassName?: string;
}

export function TabScanLabel({ box, active, icon, badge, title, titleClassName }: TabScanLabelProps) {
  return createPortal(
    <div
      aria-hidden
      style={{ position: 'fixed', ...box.slot }}
      className="pointer-events-none z-50 flex w-max select-none justify-end"
    >
      <div
        data-testid="tab-scan-label"
        style={{ minWidth: box.labelMinWidth, maxWidth: SCAN_LABEL_MAX_PX }}
        className={`flex items-center gap-2 rounded-ss-lg border border-e-0 border-t-2 border-border px-3 text-foreground shadow-md duration-100 animate-in fade-in-0 ${
          active ? 'border-t-primary bg-background' : 'bg-muted'
        }`}
      >
        {icon && <span className="inline-flex shrink-0 items-center justify-center">{icon}</span>}
        {badge}
        <span className={`min-w-0 flex-1 truncate text-sm font-medium ${titleClassName ?? ''}`}>{title}</span>
      </div>
    </div>,
    document.body,
  );
}
