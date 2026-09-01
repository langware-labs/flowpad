/**
 * The token plan view's pointer: the SCOPE. `''` | `me` → me; `team` → the
 * first team; `team/<id>` → that team; `org` → the org. Lives in the URL, so a
 * reload lands on the same scope and switching is a navigation; `foldsPointer`
 * keeps every scope in one tab chip.
 *
 * Pure — no React, and nothing from the SDK but types and the pinned scope
 * vocabulary — so tests and the harness modal can import it.
 */
import type { TokenPlanScope, TokenPlanScopeKind } from '@sdk';
import { TokenPlanKind } from '@sdk';

export interface TokenPlanPointer {
  kind: TokenPlanScopeKind;
  /** Team id when the pointer names one (`team/<id>`). */
  id?: string;
}

/** Derived from the pinned vocabulary, not a third copy of it. */
const KINDS = new Set<string>(Object.values(TokenPlanKind));

export function parseTokenPlanPointer(pointer?: string | null): TokenPlanPointer {
  const [rawKind, id] = (pointer ?? '').split('/').filter(Boolean);
  const kind = KINDS.has(rawKind) ? (rawKind as TokenPlanScopeKind) : 'me';
  return kind === 'team' && id ? { kind, id } : { kind };
}

/** `me` is the default and is written as the empty pointer. */
export function tokenPlanPointer(kind: TokenPlanScopeKind, id?: string): string {
  if (kind === 'me') return '';
  if (kind === 'team' && id) return `team/${id}`;
  return kind;
}

export function scopePointer(scope: Pick<TokenPlanScope, 'kind' | 'id'>): string {
  return tokenPlanPointer(scope.kind, scope.kind === 'team' ? scope.id : undefined);
}

/** The scope a pointer selects, or the first (`me`) when it names none. */
export function selectScope<S extends Pick<TokenPlanScope, 'kind' | 'id'>>(
  scopes: readonly S[],
  pointer: TokenPlanPointer,
): S | undefined {
  if (pointer.kind === 'team') {
    return (
      scopes.find((s) => s.kind === 'team' && (!pointer.id || s.id === pointer.id)) ??
      scopes.find((s) => s.kind === 'me') ??
      scopes[0]
    );
  }
  return scopes.find((s) => s.kind === pointer.kind) ?? scopes.find((s) => s.kind === 'me') ?? scopes[0];
}
