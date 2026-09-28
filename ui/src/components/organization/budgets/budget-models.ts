/**
 * What a budget row's model list starts as, and the redirects that make a narrow list work.
 *
 * Plain values and functions, out of `EndpointControls.tsx` so that file exports only components —
 * a non-component export there breaks React Fast Refresh.
 */
/**
 * What a budget row allows when nobody has narrowed it: the cheapest tier, and ONLY that.
 *
 * A budget row should default to the cheap model — that is the whole point of a wallet with a $1
 * cap on it. What made this dangerous before was not the narrowness but the missing half: a worker
 * asks for a TIER, `CLAUDE_API_AUTH_SPEC.tier_models` maps sm/md/lg onto three different slugs, and
 * a machine configured for `md` therefore asked for sonnet and was REFUSED by a haiku-only list —
 * with no way for that person to fix it, since the tier lives in their own CLI config. It hid well,
 * too: `test` probes the cheapest ALLOWED model, so the row showed a green tick while real traffic
 * bounced.
 *
 * `aliasesForPinnedModel` is the missing half. Pinning now also REDIRECTS the other tiers onto the
 * pinned slug, so a narrow wallet serves every caller instead of refusing most of them. Cheap and
 * working, rather than cheap and broken.
 */
/** The hub's own initial lists, restated here for the placeholder and the empty-row hint ONLY.
 *
 *  They are no longer written from this screen. `ensure_default_llm_endpoint` (hub) chooses what a
 *  new wallet allows, because it is also what mints a person's default on their first bootstrap --
 *  a path no UI is on, and the reason a person could previously be restricted only if an admin had
 *  happened to open this page. Keep these in step with `MEMBER_DEFAULT_MODELS` / `ORG_DEFAULT_MODELS`
 *  in `flowpad/hub/builtin/llm_endpoint.py`; they are a hint, so drift shows as a stale placeholder
 *  rather than as a wrong value on a row. */
export const DEFAULT_MODELS = ['anthropic/claude-haiku-4.5', 'openai/gpt-5-mini'];
export const ORG_DEFAULT_MODELS = ['anthropic/claude-*', 'openai/*'];

/** What each level of the hierarchy starts with when its list is empty. */
export type BudgetScope = 'org' | 'team' | 'person';

/**
 * Seeds by level, and the two blanks are the point.
 *
 * A child may only ever NARROW its parent (`filters.is_subset`, enforced on write with a 400), and
 * the check runs against the IMMEDIATE parent chain — not just the root. So every row that states a
 * model becomes a ceiling for everything beneath it. Pinning the team to one model would therefore
 * make "put this one person on sonnet" an illegal write, which is exactly the freedom this page
 * exists to give an admin.
 *
 * Hence: the ORG states the ceiling (what the payer is willing to fund at all), the TEAM states
 * nothing so it can never be the thing that blocks a person, and each PERSON gets the cheap default
 * — visible, and overridable one at a time without touching anyone else.
 */
export const SEED_BY_SCOPE: Record<BudgetScope, string[]> = {
  org: ORG_DEFAULT_MODELS,
  team: DEFAULT_MODELS,
  person: DEFAULT_MODELS,
};

/**
 * The family a slug belongs to, as a glob. `anthropic/claude-haiku-4.5` -> `anthropic/claude-*`.
 *
 * Deliberately a PATTERN and not a list of sibling slugs. An admin setting a budget knows which
 * model they are willing to fund; they do not know which slug each person's CLI is configured to
 * ask for, and enumerating every tier would restate a list that really lives in the worker specs
 * (`CLAUDE_API_AUTH_SPEC.tier_models`) -- a copy that silently stops matching the day a tier is
 * renamed there, taking the redirect with it. One pattern says the intent directly and keeps
 * working for models that did not exist when this was written.
 */
function familyGlobOf(slug: string): string | null {
  const match = /^([^/]+\/[a-z]+)-/.exec(slug);
  return match ? `${match[1]}-*` : null;
}

/**
 * The redirects that make an allowed list STICK, whatever each person's machine asks for.
 *
 * Allowing a model alone only ever produces a refusal: a worker asks for the tier IT is configured
 * for, and if that is not on the list the call dies with "model X not allowed by endpoint Y" --
 * which the person cannot fix, because the tier lives in their own CLI config, not on this page.
 * The hub resolves `filters.aliases` at the ENTRY endpoint BEFORE any filter check and rewrites the
 * request body (`llm_endpoint.py:1340`), so a machine set to sonnet transparently gets what the
 * wallet actually funds.
 *
 * Worked out PER FAMILY, because one list routinely spans several: `anthropic/claude-haiku-4.5` +
 * `openai/gpt-5-mini` is a wallet that serves Claude Code with the first and codex with the second.
 * A redirect never crosses families -- answering a request for one vendor with another's model
 * would be worse than refusing.
 *
 * Two things are deliberately left alone:
 *
 * * **A family already opened by a glob** (`anthropic/claude-*`) needs no redirect -- everything in
 *   it passes on its own -- and adding one would NARROW what the admin opened.
 * * **A model the admin explicitly listed** keeps working as itself. Where a family lists several,
 *   the family glob points at the first and each of the rest is given an identity entry, which wins
 *   because `resolve_alias` prefers an exact key over a glob. So an unlisted tier falls through to
 *   the first, while every listed one is still reachable — a choice the admin made stays a choice.
 */
export function aliasesForPinnedModel(models_allow: string[]): Record<string, string> {
  const byFamily = new Map<string, string[]>();
  for (const slug of models_allow) {
    if (slug.includes('*')) continue; // a glob allows a range; there is nothing to redirect to
    const family = familyGlobOf(slug);
    if (!family) continue;
    byFamily.set(family, [...(byFamily.get(family) ?? []), slug]);
  }

  const out: Record<string, string> = {};
  for (const [family, slugs] of byFamily) {
    if (models_allow.includes(family)) continue; // the family is open by glob already
    out[family] = slugs[0];
    for (const also of slugs.slice(1)) out[also] = also;
    // The same family as the VENDOR writes it, un-prefixed. An OpenRouter slug is
    // `anthropic/claude-haiku-4.5`; a client speaking Anthropic's own API asks for
    // `claude-haiku-4-5`. Both name the model this wallet is pinned to, and a list holding only the
    // routed spelling refuses the native one — a refusal the caller cannot act on, because their SDK
    // chose the name. `*` crosses `/` in the hub's matcher, so a bare key can only ever match a bare
    // request. The Python twin is `aliases_for_pinned` (`flowpad/hub/core/llm/filters.py`); the two
    // must agree or this screen's repair effect would rewrite what the hub seeded.
    const bare = family.includes('/') ? family.slice(family.indexOf('/') + 1) : null;
    if (bare && !(bare in out) && !models_allow.includes(bare)) out[bare] = slugs[0];
  }
  return out;
}
