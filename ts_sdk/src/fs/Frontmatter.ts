/**
 * Frontmatter — generic get/set access to an asset's YAML frontmatter.
 *
 * Backed by a FrontMatterFsRef (the asset's main body file). Unlike
 * `FrontMatterFsRef.save()` (which only persists name+description and drops
 * every other key), this accessor reads and writes the FULL frontmatter dict,
 * preserving the body and all unrelated keys — required for fields like the
 * running `version`.
 *
 * Usage:
 *   const fm = skill.frontmatter
 *   await fm.load()
 *   fm.version = 2            // write-through
 *   const v = fm.get('version')
 */

import { FrontMatterFsRef, extractBody, parseFrontmatter, serializeDoc } from './FrontMatterFsRef';

export class Frontmatter {
  private fields: Record<string, string> = {};
  private body: string = '';
  private loaded = false;

  constructor(private ref: FrontMatterFsRef) {}

  /** Read the file from disk and cache the parsed frontmatter + body. */
  async load(): Promise<void> {
    const raw = await this.ref.read();
    this.fields = parseFrontmatter(raw);
    this.body = extractBody(raw);
    this.loaded = true;
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error('Frontmatter.load() must be called before get/set');
    }
  }

  get(key: string): string | undefined {
    this.ensureLoaded();
    return this.fields[key];
  }

  /** Merge `{key: val}` into the frontmatter and write the full doc back. */
  async set(key: string, value: string | number): Promise<void> {
    this.ensureLoaded();
    this.fields[key] = String(value);
    await this.ref.write(serializeDoc(this.fields, this.body));
  }

  /** Snapshot of all frontmatter fields (loaded copy). */
  asObject(): Record<string, string> {
    this.ensureLoaded();
    return { ...this.fields };
  }

  /** Running asset version (0 when absent). */
  get version(): number {
    this.ensureLoaded();
    return Number(this.fields['version'] ?? 0);
  }
}
