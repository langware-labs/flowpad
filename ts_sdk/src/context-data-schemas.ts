/**
 * TS mirrors of the per-type sidecar shapes declared on the BE in
 * ``flow_sdk/core/entity/context_data_schemas.py``. Documentation +
 * type-help only — runtime values come over the wire as plain objects
 * and ``APIEntity.getContextEntryData(typeid)`` returns the loose
 * ``Record<string, unknown> | undefined`` shape.
 *
 * Callers that know what typeid they're handling cast at the use site:
 *
 *   const data = entity.getContextEntryData(planTypeId) as
 *       PlanContextData | undefined;
 *
 * Keep this file in sync with the BE module — they describe the same
 * wire contract from two sides.
 */

/** Common shape for file-backed entries (Plan, Markdown, Skill, ClaudeMd,
 *  ClaudeCommand). The path is what the BE 404 self-heal feeds into the
 *  per-type single-file indexer via ``?hint_path=...``. */
export type PathContextData = { path: string };

export type PlanContextData = PathContextData;
export type MarkdownContextData = PathContextData;
export type SkillContextData = PathContextData;
export type ClaudeMdContextData = PathContextData;
export type ClaudeCommandContextData = PathContextData;
