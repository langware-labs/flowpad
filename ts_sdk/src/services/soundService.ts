/**
 * Generic browser-side sound playback. Use for short notification cues or
 * other transient UI sounds. Caller is responsible for sourcing a playable
 * URL (typically a Vite-imported audio asset).
 *
 * Autoplay policy: browsers reject `audio.play()` calls that happen before
 * the user has interacted with the page. We swallow the rejection silently
 * — for the notification use case, missing the very first ping pre-gesture
 * is preferable to a console error in every dev session.
 */

export interface PlaySoundOptions {
  /** 0..1, clamped. Defaults to 0.6 — quieter than browser default. */
  volume?: number;
}

class SoundService {
  async play(url: string, opts?: PlaySoundOptions): Promise<void> {
    const audio = new Audio(url);
    audio.volume = Math.min(1, Math.max(0, opts?.volume ?? 0.6));
    try {
      await audio.play();
    } catch {
      // Autoplay blocked before any user gesture, or asset failed to load.
    }
  }
}

export const soundService = new SoundService();
