import { ImageUp, Trash2 } from 'lucide-react';
import { useRef } from 'react';
import { AGENT_AVATAR_REF } from '@sdk';

import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { ColorPicker } from '@src/components/ui/color-picker';
import { EmojiGrid, ICON_PICKER_EMOJI, IconGrid } from '@src/components/ui/icon-picker';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';

export interface AgentAvatarPickerProps {
  value?: string | null;
  onValueChange: (value: string | null) => void | Promise<void>;
  onImageSelected: (file: File) => void | Promise<void>;
  /** The circle's background (a palette hex), or null for the identity-derived color. */
  color?: string | null;
  onColorChange: (color: string | null) => void | Promise<void>;
}

/** The tab that holds the current avatar, so the picker opens on it. */
function tabFor(value: string | null | undefined): 'icon' | 'emoji' | 'image' {
  if (value === AGENT_AVATAR_REF) return 'image';
  return value && ICON_PICKER_EMOJI.includes(value) ? 'emoji' : 'icon';
}

/** Agent identity picker: one tab row (icon / emoji / image) and the circle's color. */
export function AgentAvatarPicker({
  value,
  onValueChange,
  onImageSelected,
  color,
  onColorChange,
}: AgentAvatarPickerProps) {
  const { t } = useLingui();
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="w-64 space-y-3">
      <Tabs defaultValue={tabFor(value)}>
        <TabsList className="h-7">
          <TabsTrigger value="icon" className="h-6 px-2 text-xs">
            <Trans>Icons</Trans>
          </TabsTrigger>
          <TabsTrigger value="emoji" className="h-6 px-2 text-xs">
            <Trans>Emoji</Trans>
          </TabsTrigger>
          <TabsTrigger value="image" className="h-6 px-2 text-xs">
            <Trans>Image</Trans>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="icon" className="mt-2">
          <IconGrid value={value} onChange={(next) => void onValueChange(next)} />
        </TabsContent>
        <TabsContent value="emoji" className="mt-2">
          <EmojiGrid value={value} onChange={(next) => void onValueChange(next)} />
        </TabsContent>
        <TabsContent value="image" className="mt-2 space-y-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label={t`Choose avatar image`}
            className="sr-only"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void onImageSelected(file);
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => inputRef.current?.click()}
          >
            <ImageUp className="me-1.5 h-3.5 w-3.5" />
            <Trans>Upload image</Trans>
          </Button>
          {value ? (
            <Button type="button" size="sm" variant="ghost" className="w-full" onClick={() => void onValueChange(null)}>
              <Trash2 className="me-1.5 h-3.5 w-3.5" />
              <Trans>Remove avatar</Trans>
            </Button>
          ) : null}
          <p className="text-xs text-muted-foreground">
            <Trans>PNG, JPEG, or WebP. Maximum 5 MiB and 4096 × 4096.</Trans>
          </p>
        </TabsContent>
      </Tabs>
      <div className="space-y-1.5 border-t pt-3">
        <span className="text-xs text-muted-foreground">
          <Trans>Color</Trans>
        </span>
        <ColorPicker value={color} onChange={(next) => void onColorChange(next)} />
      </div>
    </div>
  );
}
