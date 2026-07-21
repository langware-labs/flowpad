/** Runtime values plus a literal-union type for ergonomic URL/API use. */
export const WorldViewProjection = {
  WORLD: 'world',
  ORGANIZATION: 'organization',
  DEPLOYMENT: 'deployment',
} as const;

export type WorldViewProjection = (typeof WorldViewProjection)[keyof typeof WorldViewProjection];

const WORLDVIEW_PROJECTIONS: ReadonlySet<string> = new Set(Object.values(WorldViewProjection));

export function isWorldViewProjection(value: unknown): value is WorldViewProjection {
  return typeof value === 'string' && WORLDVIEW_PROJECTIONS.has(value);
}
