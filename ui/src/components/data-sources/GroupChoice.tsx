import { useEffect, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import type { DataDriver, DriverProfile } from '@sdk';
import { cn } from '@src/lib/utils';
import { lucideByName } from '@src/lib/lucide-by-name';
import { sourceIconName } from './source-icon';
import { IconWithBadge } from '@src/components/graph-view/icons/IconWithBadge';

/**
 * A driver group's setup phase: one choice to a person ("WhatsApp"), several ways to it — a card per member.
 *
 * Each card is the member's live `profile()` (`Source.profile()` on the backend): a way that is run for you
 * (Flowpad's own number) shows who answers and on what number, fetched now, never hardcoded here; a way
 * that is not available on this machine says why and cannot be picked.
 */
export function GroupChoice({
  group,
  members,
  selected,
  onPick,
}: {
  group: string;
  members: DataDriver[];
  selected: string;
  onPick: (driver: DataDriver) => void;
}) {
  return (
    <div className="space-y-2" data-testid="group-choice">
      <p className="text-sm font-medium">
        <Trans>How do you want to connect {group}?</Trans>
      </p>
      <div className="grid gap-2">
        {members.map((m) => (
          <MemberCard key={m.name} driver={m} selected={selected === m.name} onPick={() => onPick(m)} />
        ))}
      </div>
    </div>
  );
}

function MemberCard({ driver, selected, onPick }: { driver: DataDriver; selected: boolean; onPick: () => void }) {
  const [profile, setProfile] = useState<DriverProfile | null>(null);

  useEffect(() => {
    let alive = true;
    void driver
      .profile()
      .then((p) => alive && setProfile(p ?? {}))
      .catch(() => alive && setProfile({}));
    return () => {
      alive = false;
    };
  }, [driver]);

  const Glyph = lucideByName(sourceIconName(driver, null));
  // The card is the group's glyph marked with whose way this is: Flow's is WhatsApp badged with Flowpad's logo, your
  // own bot's is plain WhatsApp. Never the profile's avatar -- Flow's is an emoji, and an emoji in <img> is a
  // broken image.
  const groupGlyph = driver.group_icon_name ? lucideByName(driver.group_icon_name) : null;
  const badged = groupGlyph && driver.group_icon_name !== driver.icon_name;
  const unavailable = profile?.available === false;
  return (
    <button
      type="button"
      data-testid={`group-member-${driver.name}`}
      disabled={unavailable}
      onClick={onPick}
      className={cn(
        'flex w-full items-start gap-3 rounded border p-3 text-start transition-colors',
        'hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60',
        selected && 'border-primary bg-accent ring-1 ring-primary',
      )}
    >
      <IconWithBadge
        Base={badged ? groupGlyph : Glyph}
        Badge={badged ? Glyph : null}
        className="mt-0.5 size-7 shrink-0"
        data-testid={`group-member-icon-${driver.name}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{driver.title || driver.name}</span>
        <span className="block text-xs text-muted-foreground">{profile?.description || driver.description}</span>
        {profile?.number && (
          <span
            className="mt-0.5 block text-xs text-muted-foreground"
            data-testid={`group-member-number-${driver.name}`}
          >
            {profile.name ? `${profile.name} · ` : ''}
            {profile.number}
          </span>
        )}
        {unavailable && profile?.detail && <span className="mt-0.5 block text-xs">{profile.detail}</span>}
      </span>
    </button>
  );
}
