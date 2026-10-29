import { useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { LifeBuoy } from 'lucide-react';
import { ConversationParticipant, helpRecipients, type HelpRecipient, type HelpRecipients } from '@sdk';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { cn } from '@src/lib/utils';

interface ShareWithRowProps {
  projectId: string | null;
  onChange: (recipients: HelpRecipient[]) => void;
}

const CHIP = 'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs';

/**
 * "Share the results with" — the help desk(s) this Flowpad knows, as chips (shown, not picked),
 * and anyone from the address book or by email. The same pieces as Ask for help; unlike it, a
 * desk and people can both be picked (each desk gets its own ticket, the people one conversation).
 */
export function ShareWithRow({ projectId, onChange }: ShareWithRowProps) {
  const { t } = useLingui();
  const [recipients, setRecipients] = useState<HelpRecipients | null>(null);
  const [deskOn, setDeskOn] = useState<string | null>(null);
  const [people, setPeople] = useState<ConversationParticipant[]>([]);

  useEffect(() => {
    let live = true;
    void helpRecipients(projectId)
      .catch((): HelpRecipients => ({ desks: [], default_state: 'unknown' }))
      .then((r) => live && setRecipients(r));
    return () => {
      live = false;
    };
  }, [projectId]);

  const desks = recipients?.desks ?? [];

  /** Tell the window who is picked — from the two places a pick changes, not from an effect. */
  const emit = (desk: string | null, picked: ConversationParticipant[]) => {
    const chosen = desks.find((d) => (d.desk_project_id ?? 'nearest') === desk);
    onChange([
      ...(chosen ? [{ ...chosen, kind: 'desk' as const }] : []),
      ...picked.map((p) => ({
        kind: 'person' as const,
        email: p.email ?? null,
        user_id: p.user_id ?? null,
        name: p.name ?? null,
      })),
    ]);
  };
  const pickDesk = (key: string | null) => {
    setDeskOn(key);
    emit(key, people);
  };
  const pickPeople = (next: ConversationParticipant[]) => {
    setPeople(next);
    emit(deskOn, next);
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid="diagnose-share">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t`Share the results with`}
      </div>
      {desks.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {desks.map((d) => {
            const key = d.desk_project_id ?? 'nearest';
            const on = deskOn === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => pickDesk(on ? null : key)}
                className={cn(
                  CHIP,
                  on ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground',
                )}
                data-testid={`diagnose-share-desk-${key}`}
              >
                <LifeBuoy className="h-3 w-3" />
                {d.name ?? t`Help desk`}
              </button>
            );
          })}
        </div>
      )}
      <ContactPicker
        value={people}
        onChange={pickPeople}
        placeholder={desks.length ? t`Or pick a person, or type an email` : t`Pick a person or type an email`}
        testId="diagnose-share-person"
      />
    </div>
  );
}
