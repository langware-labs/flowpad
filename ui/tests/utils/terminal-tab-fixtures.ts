/**
 * Shared test helper: a deterministic valid-v4-shaped UUID from a readable label
 * (TypeId enforces the entity-id policy, so test ids must be real v4/v5 UUIDs).
 * The label stays on `name` for assertions.
 */
export function uid(label: string): string {
  const hex = Array.from(label)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(8, '0')
    .slice(0, 8);
  return `${hex}-0000-4000-8000-000000000000`;
}
