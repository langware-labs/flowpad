/**
 * Mulberry32 PRNG — deterministic, seedable, fast.
 * https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32
 */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Returns a float in [0, 1). */
  nextFloat(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    z = (z ^ (z >>> 14)) >>> 0;
    return z / 0x100000000;
  }

  /** Returns a random lowercase word of 3–8 chars. */
  nextWord(): string {
    const consonants = 'bcdfghjklmnpqrstvwxz';
    const vowels = 'aeiou';
    const len = 3 + Math.floor(this.nextFloat() * 6); // 3–8
    let word = '';
    for (let i = 0; i < len; i++) {
      word += i % 2 === 0
        ? consonants[Math.floor(this.nextFloat() * consonants.length)]
        : vowels[Math.floor(this.nextFloat() * vowels.length)];
    }
    return word;
  }

  /** Returns n space-separated words. */
  nextWords(n: number): string {
    const words: string[] = [];
    for (let i = 0; i < n; i++) words.push(this.nextWord());
    return words.join(' ');
  }
}
