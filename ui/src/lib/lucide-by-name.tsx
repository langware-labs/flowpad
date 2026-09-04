import { useState } from 'react';
import * as lucideIcons from 'lucide-react';
import { FileText, type LucideIcon } from 'lucide-react';
import { AtlassianIcon } from '@src/components/icons/AtlassianIcon';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { CloudMailboxIcon } from '@src/components/icons/CloudMailboxIcon';
import { CopilotIcon } from '@src/components/icons/CopilotIcon';
import { GmailIcon } from '@src/components/icons/GmailIcon';
import { GoogleCloudStorageIcon } from '@src/components/icons/GoogleCloudStorageIcon';
import { GitlabIcon } from '@src/components/icons/GitlabIcon';
import { GoogleDriveIcon } from '@src/components/icons/GoogleDriveIcon';
import { MicrosoftIcon } from '@src/components/icons/MicrosoftIcon';
import { LinearIcon } from '@src/components/icons/LinearIcon';
import { OpenCodeIcon } from '@src/components/icons/OpenCodeIcon';
import { SlackIcon } from '@src/components/icons/SlackIcon';
import { TelegramIcon } from '@src/components/icons/TelegramIcon';
import { iconAssetUrl } from '@sdk';

/**
 * Custom (non-lucide) icon components addressable by the same string name that
 * the backend type registry publishes in `TypeInfo.icon`. Lets a type opt into
 * a bespoke glyph (e.g. a worker's vendor logo) while keeping the backend as
 * the single source of truth for which icon a type uses. Consulted before
 * lucide.
 */
const CUSTOM_ICONS: Record<string, LucideIcon> = {
  // Worker-session vendor logos. Registered here rather than mapped at a call
  // site so `iconForType('claude_session')` resolves the real glyph on EVERY
  // surface — search rows, project resource lists, and the attachment chip a
  // received transcript renders as.
  ClaudeCode: ClaudeIcon as unknown as LucideIcon,
  Codex: CodexIcon as unknown as LucideIcon,
  Copilot: CopilotIcon as unknown as LucideIcon,
  OpenCode: OpenCodeIcon as unknown as LucideIcon,
  // Connection providers whose brand mark is monochrome: registered here, not in
  // the Connections tab's own table, so the glyph resolves wherever a provider
  // icon is rendered.
  Atlassian: AtlassianIcon,
  Linear: LinearIcon,
  // Shadows lucide's monochrome `Gitlab` with the same shape in GitLab's orange.
  Gitlab: GitlabIcon,
  // Names nothing resolved before: lucide has no Microsoft or Google glyph, so
  // both providers fell through to the generic key in the catalogue — a tile
  // that said "no icon found" where a person is choosing BETWEEN providers.
  Microsoft: MicrosoftIcon,
  // Drive's mark for the `google` provider deliberately: that one grant covers
  // Drive and Cloud Storage, and Drive is the half a person recognises. A
  // four-colour "G" would be the accurate mark and is not worth approximating
  // badly — if Google ever needs its own, it gets its own component.
  Google: GoogleDriveIcon,
  // Shadows lucide's monochrome `Slack`: on an inbox row the colour is the
  // attribution, so the brand mark wears its own.
  Slack: SlackIcon,
  // Data-source providers whose own mark says which one it is. Registered for
  // the same reason as the harness logos: three providers ship a mailbox and a
  // fourth a bucket, and lucide's `Mail` / `Cloud` / `Send` made them
  // indistinguishable in the picker — the one place a person is choosing
  // BETWEEN them. Each is named by its manifest's `icon_name`, so the backend
  // stays the one that decides which glyph a provider wears.
  CloudMailbox: CloudMailboxIcon,
  Gmail: GmailIcon,
  GoogleCloudStorage: GoogleCloudStorageIcon,
  GoogleDrive: GoogleDriveIcon,
  Telegram: TelegramIcon,
};

/**
 * Image-backed icons, one component per URL.
 *
 * Cached because `lucideByName` is called DURING RENDER (`iconForType(type)` in
 * a component body). A fresh component identity every render is a different
 * element type to React, which unmounts and remounts the `<img>` — refetch,
 * flicker, and any load state thrown away, on every single render.
 *
 * Typed as `LucideIcon` so a file-backed icon is substitutable everywhere a
 * lucide glyph is: call sites pass `className` and nothing else. SVG-only props
 * would be dropped, but nothing sizes these by `strokeWidth`.
 */
const IMAGE_ICONS = new Map<string, LucideIcon>();

function imageIcon(src: string): LucideIcon {
  const cached = IMAGE_ICONS.get(src);
  if (cached) return cached;
  const Icon = ({ className }: { className?: string }) => {
    // A 404 must land on the SAME generic glyph a typo'd lucide name does —
    // otherwise a missing file renders as the browser's broken-image chrome,
    // which reads as a rendering bug rather than a missing icon.
    const [failed, setFailed] = useState(false);
    if (failed) return <FileText className={className} />;
    // `alt=""` + aria-hidden: every call site pairs the glyph with its own
    // label, so announcing the file name would just be noise.
    return <img src={src} alt="" aria-hidden className={className} onError={() => setFailed(true)} />;
  };
  Icon.displayName = `ImageIcon(${src})`;
  const asLucide = Icon as unknown as LucideIcon;
  IMAGE_ICONS.set(src, asLucide);
  return asLucide;
}

/**
 * Resolve an icon component from the string the backend registry publishes.
 *
 * Three shapes, in order: a custom component registered above, a FILE the
 * backend serves (any string with a slash, or a data URI — see `iconAssetUrl`,
 * which owns that discrimination and the API origin), and a `lucide-react`
 * export name. Returns `FileText` when nothing resolves — the same generic
 * glyph `iconForType()` falls back to, so a missing-icon type and a typo'd-icon
 * type render identically (previously this returned `File` while iconForType
 * returned `FileText`, giving two different "unknown" glyphs).
 */
/** Names this module can resolve to a component beyond lucide's own exports —
 *  the bespoke brand marks registered above. `icon-value.isLucideName` folds
 *  this in so there is ONE "can this string render" predicate rather than two. */
export function isCustomIconName(iconName: string | null | undefined): boolean {
  return !!iconName && iconName in CUSTOM_ICONS;
}

export function lucideByName(iconName: string | null | undefined): LucideIcon {
  if (!iconName) return FileText;
  const custom = CUSTOM_ICONS[iconName];
  if (custom) return custom;
  const url = iconAssetUrl(iconName);
  if (url) return imageIcon(url);
  const exports = lucideIcons as unknown as Record<string, unknown>;
  const candidate = exports[iconName];
  return (candidate ?? FileText) as LucideIcon;
}
