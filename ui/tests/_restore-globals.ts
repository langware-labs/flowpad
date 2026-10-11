/**
 * Put back shared globals a test file overwrote DIRECTLY (not via `vi.stubGlobal`,
 * which `unstubAllGlobals` reverts) — a setup file for the singleThread tiers, where
 * every file shares one thread and one jsdom document, so a fake outlives its file.
 *
 * `URL`'s static members are restored generically: any key a file added is deleted,
 * any it changed is put back. (A leaked `URL.createObjectURL` made
 * `prepareAvatarImage` await an Image load jsdom never fires — RCA a281275c2.)
 * `Image` is listed by name; the window has too many keys to diff wholesale.
 *
 * Snapshot at file start = after the previous file's restore, so always pristine.
 */
import { afterAll } from 'vitest';

type Snapshot = ReadonlyArray<readonly [key: string, descriptor: PropertyDescriptor | undefined, value: unknown]>;
type Bag = Record<string, unknown>;

/** Descriptor AND value: jsdom's window globals (`Image`) are getter/setter pairs,
 *  so an assignment goes through the setter and keeps the same descriptor — only
 *  the value read back tells that it changed. */
function snapshot(owner: object, keys: readonly string[]): Snapshot {
  return keys.map((key) => [key, Object.getOwnPropertyDescriptor(owner, key), (owner as Bag)[key]] as const);
}

function restore(owner: object, before: Snapshot, addedSince: readonly string[] = []): void {
  for (const key of addedSince) delete (owner as Bag)[key];
  for (const [key, descriptor, value] of before) {
    if (!descriptor) {
      delete (owner as Bag)[key];
      continue;
    }
    Object.defineProperty(owner, key, descriptor);
    if ((owner as Bag)[key] !== value) (owner as Bag)[key] = value;
  }
}

const urlBefore = snapshot(URL, Object.getOwnPropertyNames(URL));
const windowBefore = snapshot(globalThis, ['Image']);

afterAll(() => {
  const known = new Set(urlBefore.map(([key]) => key));
  restore(URL, urlBefore, Object.getOwnPropertyNames(URL).filter((key) => !known.has(key)));
  restore(globalThis, windowBefore);
});
