/**
 * Auto-enumerated notification-sound manifest.
 *
 * Add or remove a `.mp3` file in this folder and the picker updates with
 * no code changes. Filenames follow `<freesoundId>_<author>_<slug>.mp3`
 * (see CREDITS.md) — we strip the id+author prefix to derive a stable,
 * human-readable key. The key is what's persisted in WorkspaceSettings,
 * so it survives Vite build-hash changes on the URL.
 */

const urls = import.meta.glob('./*.mp3', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

export interface NotificationSound {
  /** Stable identifier persisted in settings (e.g. "supershort-ping"). */
  key: string;
  /** Title-cased label for the picker UI. */
  displayName: string;
  /** Vite-resolved URL — changes per build, so never persist this. */
  url: string;
}

const titleCase = (slug: string): string =>
  slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

export const NOTIFICATION_SOUNDS: ReadonlyArray<NotificationSound> = Object.entries(urls)
  .map(([path, url]) => {
    // path looks like "./555544_stwime_shuffle.mp3"
    const file = path.replace(/^\.\//, '').replace(/\.mp3$/, '');
    const slug = file.replace(/^\d+_[^_]+_/, '');
    return { key: slug, displayName: titleCase(slug), url };
  })
  .sort((a, b) => a.displayName.localeCompare(b.displayName));

export const DEFAULT_SOUND_KEY = 'supershort-ping';

export function soundByKey(key: string): NotificationSound | undefined {
  return (
    NOTIFICATION_SOUNDS.find((s) => s.key === key) ??
    NOTIFICATION_SOUNDS.find((s) => s.key === DEFAULT_SOUND_KEY) ??
    NOTIFICATION_SOUNDS[0]
  );
}
