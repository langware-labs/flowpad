import type { Agent, AssistantSkillChoice } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { Checkbox } from '@src/components/ui/checkbox';

/**
 * Which of the Flowpad Assistant's skills the agent loads. "All skills" leaves `assistant_skills`
 * unset (every skill, including ones a later release adds); unticking it starts from every skill
 * picked, so the user removes what the agent should not have.
 */
export function AgentAssistantSkillsField({
  agent,
  value,
  onCommit,
}: {
  agent: Agent;
  value: string[] | null | undefined;
  onCommit: (value: string[] | undefined) => void;
}) {
  const { t } = useLingui();
  const [catalog, setCatalog] = useState<AssistantSkillChoice[] | null>(null);

  useEffect(() => {
    let live = true;
    agent
      .assistantSkillCatalog()
      .then((skills) => live && setCatalog(skills))
      .catch(() => live && setCatalog([]));
    return () => {
      live = false;
    };
  }, [agent]);

  const all = value == null;
  const picked = new Set(value ?? []);
  const toggle = (name: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(name);
    else next.delete(name);
    onCommit([...next].sort());
  };

  return (
    <div className="mt-2 space-y-2 border-t border-border pt-2" data-testid="agent-assistant-skills">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={all}
          onCheckedChange={(on) => onCommit(on === true ? undefined : (catalog ?? []).map((s) => s.name))}
          aria-label={t`All skills`}
        />
        <Trans>All skills</Trans>
      </label>
      {catalog === null ? (
        <p className="text-xs text-muted-foreground">
          <Trans>Loading skills…</Trans>
        </p>
      ) : (
        <ul className="max-h-64 space-y-1 overflow-y-auto pl-1">
          {catalog.map((skill) => (
            <li key={skill.name}>
              <label className="flex items-start gap-2 text-sm" title={skill.description}>
                <Checkbox
                  className="mt-0.5"
                  checked={all || picked.has(skill.name)}
                  disabled={all}
                  onCheckedChange={(on) => toggle(skill.name, on === true)}
                  aria-label={skill.name}
                />
                <span className="font-mono text-xs">{skill.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
