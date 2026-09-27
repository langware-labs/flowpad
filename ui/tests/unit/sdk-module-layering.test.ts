/**
 * The SDK's module layering, enforced.
 *
 * `APIEntity` is the base class of every entity. If its module graph reaches back
 * down to its own subclasses, the loader has to hand somebody a half-built module:
 * vite-node returns the partial exports (client.mjs `cachedRequest` — a module on
 * the callstack, or one whose imports intersect its importers), and esbuild lowers
 * `export class` to a `var` assigned at the end, so the binding reads `undefined`
 * rather than throwing. The bundled production build hides it (rollup fixes one
 * working module order at build time), so the only place it surfaces is the react
 * tier — as a "Class extends value undefined" that moves from file to file, because
 * vitest re-orders test files by their last-run duration.
 *
 * Three rules keep the graph acyclic, and this test is the only thing that keeps them:
 *
 *  1. No module inside the SDK imports the SDK's own barrel. A barrel is "everything
 *     in the package", so importing it from inside the package is a self-cycle by
 *     construction — that is how the base class first reached its subclasses.
 *  2. Nothing `APIEntity` can reach at load time may declare a subclass of it. A wire
 *     shape belongs below the classes, in a sibling `entities/<name>-types.ts` (the
 *     split `entities/compute-node/compute-node-types.ts` established); a lower layer
 *     names the shape, never the class.
 *  3. Nothing in `APIEntity`'s own subtree imports `APIEntity` back. This is the rule
 *     that actually bites, and every violation so far wanted only `dataManager`.
 *
 * All three are about EAGER edges: `import type` is erased, so it cannot close a
 * cycle. A dynamic `await import()` DOES count — vite-node routes it through the
 * same request path and reuses the callstack captured when the importing module was
 * evaluated, so a module first loaded inside APIEntity's load keeps taking the cycle
 * branch on every later dynamic import it issues.
 *
 * The scan uses the TypeScript compiler, not regexes, for the reason
 * `scripts/check-undefined-names.js` states: "a pattern that is one call-syntax short
 * is worse than no check because it reads as an all-clear." The first version of this
 * file was a regex scanner that stripped block comments before line comments, so a
 * `//` comment containing a `/*` — this file's own `entities/*-types.ts` — opened a
 * phantom block comment and hid all ten imports of `models/BootstrapInfo.ts`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SDK_SRC = path.resolve(__dirname, '../../../ts_sdk/src');
const BARREL = path.join(SDK_SRC, 'index.ts');
const API_ENTITY = path.join(SDK_SRC, 'APIEntity.ts');

function sdkFiles(dir: string = SDK_SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sdkFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
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

interface Edges {
  /** Modules evaluated because this one was: value imports, re-exports, side effects. */
  eager: string[];
  /** `await import('x')` — deferred, but vite-node still treats it as a cycle edge. */
  dynamic: string[];
}

/** Every erased form: `import type X`, `import { type X }`, `export type { X } from`. */
function isTypeOnlyImport(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false; // `import 'x'` is a side effect, so eager
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return (
    !clause.name &&
    !!bindings &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

const parsed = new Map<string, ts.SourceFile>();
function sourceOf(file: string): ts.SourceFile {
  let source = parsed.get(file);
  if (!source) {
    source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    parsed.set(file, source);
  }
  return source;
}

const edgeCache = new Map<string, Edges>();
function edges(file: string): Edges {
  const cached = edgeCache.get(file);
  if (cached) return cached;
  const found: Edges = { eager: [], dynamic: [] };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = resolveSpecifier(file, node.moduleSpecifier.text);
      if (target && !isTypeOnlyImport(node.importClause)) found.eager.push(target);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = resolveSpecifier(file, node.moduleSpecifier.text);
      if (target && !node.isTypeOnly) found.eager.push(target);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const target = resolveSpecifier(file, node.arguments[0].text);
      if (target) found.dynamic.push(target);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceOf(file));
  edgeCache.set(file, found);
  return found;
}

/** Every module reachable from `APIEntity` at load time, with the trail that got there. */
function apiEntityClosure(): Map<string, string[]> {
  const seen = new Map<string, string[]>([[API_ENTITY, ['APIEntity.ts']]]);
  const queue = [API_ENTITY];
  while (queue.length) {
    const current = queue.shift()!;
    const trail = seen.get(current)!;
    for (const next of edges(current).eager) {
      if (seen.has(next)) continue;
      seen.set(next, [...trail, path.relative(SDK_SRC, next)]);
      queue.push(next);
    }
  }
  return seen;
}

/** `class X extends APIEntity`, in every form the codebase could spell it. */
function declaresSubclass(file: string): boolean {
  return sourceOf(file).statements.some(
    (statement) =>
      ts.isClassDeclaration(statement) &&
      !!statement.heritageClauses?.some(
        (clause) =>
          clause.token === ts.SyntaxKind.ExtendsKeyword &&
          clause.types.some((t) => ts.isIdentifier(t.expression) && t.expression.text === 'APIEntity'),
      ),
  );
}

describe('SDK module layering', () => {
  it('no module inside the SDK imports the SDK barrel', () => {
    const offenders = sdkFiles()
      .filter((file) => file !== BARREL && edges(file).eager.includes(BARREL))
      .map((file) => path.relative(SDK_SRC, file));
    expect(offenders, 'a barrel import from inside the package is a self-cycle — import the owning module').toEqual([]);
  });

  it('APIEntity cannot reach a subclass of itself at load time', () => {
    const offenders = [...apiEntityClosure()]
      .filter(([file]) => file !== API_ENTITY && declaresSubclass(file))
      .map(([, trail]) => trail.join(' -> '));
    expect(
      offenders,
      'the base class loads its own subclasses — see the wire-shape split in entities/*-types.ts',
    ).toEqual([]);
  });

  it('nothing in APIEntity’s own subtree imports APIEntity back', () => {
    const offenders = [...apiEntityClosure()]
      .filter(([file]) => {
        if (file === API_ENTITY) return false;
        const { eager, dynamic } = edges(file);
        return eager.includes(API_ENTITY) || dynamic.includes(API_ENTITY);
      })
      .map(([, trail]) => trail.join(' -> '));
    expect(offenders, 'APIEntity is in a cycle with itself — import the owning module, not a barrel').toEqual([]);
  });
});
