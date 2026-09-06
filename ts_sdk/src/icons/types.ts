/**
 * The icon vocabulary, as the backend publishes it.
 *
 * These mirror `flow_sdk/schema/data_spec/icon_spec.py` field for field. The
 * Python side is the source of truth: it owns the manifests, and it is what
 * validates a tag before it is ever published.
 */

/** One named glyph, addressed as `<pack.kind>.<kind>`. */
export interface IconSpec {
  /** The leaf segment — `slack`. */
  kind: string;
  /** Path to the artwork, relative to the pack's `base`. */
  asset?: string;
  /**
   * Render as a CSS mask over `currentColor` rather than an `<img>`.
   *
   * This is the field that makes an icon usable outside React: a masked glyph
   * inherits the surrounding text colour the way a font does, and an `<img>`
   * cannot. Defaults to `true` — matching the Python default, which is what an
   * omitted key means on the wire.
   */
  tintable?: boolean;
  /** Default tint for a tintable glyph; empty inherits `currentColor`. */
  color?: string;
  /**
   * Artwork for a dark ground. Selected by CSS, never asked for — the viewer
   * has three theme states and only two are legible to JS.
   */
  dark?: string;
  /**
   * Sub-icons: role -> the TAG of a glyph to badge onto this one.
   *
   * `{ restore: 'lucide.history' }` means `<tag>.restore` draws this icon with
   * a small history badge on its corner. It replaces what the repo did before —
   * a hand-drawn `ClaudeRestoreIcon` per vendor, four components differing only
   * in which mark sits under the same arrow, and which no fifth vendor got for
   * free. Composition needs no file per pairing.
   */
  sub?: Record<string, string>;
  /** Other names that mean this icon. */
  aliases?: string[];
  /** Where the artwork came from. */
  source?: string;
}

/** A namespace of icons — a declared family, or a carried set. */
export interface IconPackSpec {
  version?: number;
  /** The pack's tag — the parent segment every icon in it hangs off. */
  kind: string;
  /** URL root the pack's asset paths hang off, relative to the backend origin. */
  base?: string;
  license?: string;
  /** Empty means the pack declares a family the renderer already bundles. */
  icons?: IconSpec[];
  /**
   * For a bundle pack: the leaf names the backend actually has artwork for,
   * derived from its directory rather than listed in the manifest. Present so a
   * client can enumerate what it may ask for — the static mount serves no
   * directory index, and a hand-written list would be a second copy that drifts.
   */
  served?: string[];
}

/**
 * What a tag resolved to.
 *
 * `kind` is the render strategy, and the cases are genuinely different things
 * rather than degrees of success:
 *
 *  - `asset`  — artwork to fetch; `tintable` says mask vs `<img>`
 *  - `bundle` — the renderer already has the geometry under `name`. A
 *               registered bundle renderer draws it directly; `url` is the
 *               fallback for a caller that has no such renderer (plain HTML).
 *  - `path`   — the reference was already a location, not a name
 *  - `text`   — the value IS the glyph: an emoji, or initials. The icon picker
 *               has an emoji tab that stores the character, so `Group.icon` may
 *               literally be "🎨" — a live authoring format, not legacy data.
 *  - `none`   — nothing claims it; the caller draws its own fallback
 */
export type IconResolution =
  | {
      kind: 'asset';
      pack: string;
      /** The icon's canonical full tag — never the alias that was asked for. */
      tag: string;
      /** What the caller passed, normalized. */
      asked: string;
      /** True when best-match walked up: the requested role does not exist. */
      degraded: boolean;
      url: string;
      tintable: boolean;
      color: string;
      darkUrl?: string;
      /** A resolved sub-icon to badge onto this one. One level — a badge on a
       *  badge is a drawing, not an icon. */
      badge?: IconResolution;
    }
  | {
      kind: 'bundle';
      pack: string;
      tag: string;
      asked: string;
      degraded: boolean;
      /** The leaf a bundle renderer looks up — `rss`. */
      name: string;
      url?: string;
      tintable: boolean;
      color: string;
      badge?: IconResolution;
    }
  | { kind: 'path'; url: string }
  | { kind: 'text'; text: string }
  | { kind: 'none'; ref: string };
