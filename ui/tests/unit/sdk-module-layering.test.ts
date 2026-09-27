/**
 * The SDK's module layering, enforced.
 *
 * `APIEntity` is the base class of every entity. If its module graph reaches back
 * down to its own subclasses, the loader has to hand somebody a half-built module:
 * vite-node returns the partial exports and `class X extends APIEntity` evaluates
 * `extends undefined`. The bundled production build hides it (rollup fixes one
 * working module order at build time), so the only place it surfaces is the react
 * tier — as a "Class extends value undefined" that moves from file to file, because
 * vitest re-orders test files by their last-run duration.
 *
 * Two rules keep the graph acyclic, and this test is the only thing that keeps them:
 *
 *  1. No module inside the SDK imports the SDK's own barrel. A barrel is "everything
 *     in the package", so importing it from inside the package is a self-cycle by
 *     construction — that is how the base class ended up importing its subclasses.
 *  2. Nothing `APIEntity` can reach at load time may declare a subclass of it. A wire
 *     shape belongs below the classes (`entities/<name>-types.ts`, the split that
 *     `entities/compute-node/compute-node-types.ts` established); a lower layer names
 *     the shape, never the class.
 *
 * Both rules are about EAGER edges only — `import type` is erased, and a dynamic
 * `await import()` runs after load — so those do not count.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const SDK_SRC = path.resolve(__dirname, '../../../ts_sdk/src');
const BARREL = path.join(SDK_SRC, 'index.ts');

function sdkFiles(dir: string = SDK_SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sdkFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

/** Source with comments removed, so a specifier inside one is not read as an import. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

function resolveSpecifier(from: string, spec: string): string | null {
  const base = spec.startsWith('@sdk')
    ? path.join(SDK_SRC, spec.slice('@sdk'.length + 1) || 'index')
    : spec.startsWith('.')
      ? path.resolve(path.dirname(from), spec)
      : null;
  if (base === null) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not this one */
    }
  }
  return null;
}

/** The modules `file` pulls in at EVALUATION time: value imports and re-exports only. */
function eagerImports(file: string): string[] {
  const src = code(file);
  const out: string[] = [];
  for (const m of src.matchAll(/^(?:import|export)(\s+type\b)?[\s\S]*?from\s*'([^']+)'/gm)) {
    if (m[1]) continue; // `import type` / `export type` is erased
    const target = resolveSpecifier(file, m[2]);
    if (target) out.push(target);
  }
  for (const m of src.matchAll(/^import\s*'([^']+)'/gm)) {
    const target = resolveSpecifier(file, m[1]); // side-effect import
    if (target) out.push(target);
  }
  return out;
}

/**
 * `await import('x')` counts too. vite-node routes dynamic imports through the same
 * request path as static ones, and the callstack it checks was captured when the
 * importing module was evaluated — so a module loaded inside APIEntity's own load
 * keeps taking the cycle branch on every later dynamic import of it.
 */
function dynamicImports(file: string): string[] {
  const out: string[] = [];
  for (const m of code(file).matchAll(/import\(\s*'([^']+)'\s*\)/g)) {
    const target = resolveSpecifier(file, m[1]);
    if (target) out.push(target);
  }
  return out;
}

const DECLARES_SUBCLASS = /^@?\w*\s*\n?export class \w+(?:<[^>]*>)? extends APIEntity/m;

describe('SDK module layering', () => {
  it('no module inside the SDK imports the SDK barrel', () => {
    const offenders = sdkFiles()
      .filter((f) => f !== BARREL)
      .filter((f) => eagerImports(f).includes(BARREL))
      .map((f) => path.relative(SDK_SRC, f));
    expect(offenders, 'a barrel import from inside the package is a self-cycle — import the owning module').toEqual([]);
  });

  const apiEntity = path.join(SDK_SRC, 'APIEntity.ts');

  /** Every module reachable from `APIEntity` at load time, with the trail that got there. */
  function apiEntityClosure(): Map<string, string[]> {
    const seen = new Map<string, string[]>([[apiEntity, ['APIEntity.ts']]]);
    const queue = [apiEntity];
    while (queue.length) {
      const current = queue.shift()!;
      const trail = seen.get(current)!;
      for (const next of eagerImports(current)) {
        if (seen.has(next)) continue;
        seen.set(next, [...trail, path.relative(SDK_SRC, next)]);
        queue.push(next);
      }
    }
    return seen;
  }

  it('APIEntity cannot reach a subclass of itself at load time', () => {
    const offenders = [...apiEntityClosure()]
      .filter(([file]) => file !== apiEntity && DECLARES_SUBCLASS.test(code(file)))
      .map(([, trail]) => trail.join(' -> '));
    expect(
      offenders,
      'the base class loads its own subclasses — see the wire-shape split in entities/*-types.ts',
    ).toEqual([]);
  });

  /**
   * The one that actually bites. A module inside APIEntity's own subtree that imports
   * APIEntity back gets the exports object while it is still being filled, and esbuild
   * lowers `export class X` to a `var` assigned at the end — so the binding reads
   * `undefined` rather than throwing. Every such module so far wanted only
   * `dataManager`, and was dragged in by a barrel import.
   */
  it('nothing in APIEntity’s own subtree imports APIEntity back', () => {
    const offenders = [...apiEntityClosure()]
      .filter(
        ([file]) =>
          file !== apiEntity && (eagerImports(file).includes(apiEntity) || dynamicImports(file).includes(apiEntity)),
      )
      .map(([, trail]) => trail.join(' -> '));
    expect(offenders, 'APIEntity is in a cycle with itself — import the owning module, not a barrel').toEqual([]);
  });
});
