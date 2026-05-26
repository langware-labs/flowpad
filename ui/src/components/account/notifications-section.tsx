import { soundService } from '@sdk';
import { useInstancePreferences } from '@sdk/react/hooks/use-instance-preferences';
import { Checkbox } from '@src/components/ui/checkbox';
import { Label } from '@src/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@src/components/ui/radio-group';
import { NOTIFICATION_SOUNDS } from '@src/assets/sounds/notification/manifest';
import { Play } from 'lucide-react';

export function NotificationsSection() {
  const { preferences } = useInstancePreferences();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Checkbox
          id="notification-sound-enabled"
          checked={preferences.notificationSoundEnabled}
          onCheckedChange={(checked) => {
            preferences.notificationSoundEnabled = checked === true;
          }}
        />
        <Label htmlFor="notification-sound-enabled" className="cursor-pointer text-sm">
          Play a sound when an agent is waiting for me
        </Label>
      </div>

      <div>
        <Label className="mb-2 block text-sm font-medium">Sound</Label>
        <p className="mb-2 text-xs text-muted-foreground">
          Plays each time an agentic process becomes ready for your input.
          Use the play button to preview a sound.
        </p>
        <RadioGroup
          value={preferences.notificationSoundKey}
          onValueChange={(value) => {
            preferences.notificationSoundKey = value;
          }}
        >
          {NOTIFICATION_SOUNDS.map((sound) => (
            <div key={sound.key} className="flex items-center gap-2">
              <RadioGroupItem value={sound.key} id={`sound-${sound.key}`} />
              <Label htmlFor={`sound-${sound.key}`} className="flex-1 cursor-pointer text-sm">
                {sound.displayName}
              </Label>
              <button
                type="button"
                onClick={() => void soundService.play(sound.url)}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={`Preview ${sound.displayName}`}
                aria-label={`Preview ${sound.displayName}`}
              >
                <Play className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </RadioGroup>
      </div>
    </div>
  );
}
