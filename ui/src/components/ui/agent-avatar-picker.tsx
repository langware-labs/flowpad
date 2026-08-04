import { ImageUp, Trash2 } from 'lucide-react';
import { useRef } from 'react';

import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { IconPicker } from '@src/components/ui/icon-picker';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';

export interface AgentAvatarPickerProps {
  value?: string | null;
  onValueChange: (value: string | null) => void | Promise<void>;
  onImageSelected: (file: File) => void | Promise<void>;
}

/** Agent identity picker: shared icon choices plus a portable raster upload. */
export function AgentAvatarPicker({ value, onValueChange, onImageSelected }: AgentAvatarPickerProps) {
  const { t } = useLingui();
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <Tabs defaultValue="icon" className="w-64">
      <TabsList className="h-7">
        <TabsTrigger value="icon" className="h-6 px-2 text-xs">
          <Trans>Icon</Trans>
        </TabsTrigger>
        <TabsTrigger value="image" className="h-6 px-2 text-xs">
          <Trans>Image</Trans>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="icon" className="mt-2">
        <IconPicker value={value} onChange={(next) => void onValueChange(next)} />
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
        <Button type="button" size="sm" variant="outline" className="w-full" onClick={() => inputRef.current?.click()}>
          <ImageUp className="mr-1.5 h-3.5 w-3.5" />
          <Trans>Upload image</Trans>
        </Button>
        {value ? (
          <Button type="button" size="sm" variant="ghost" className="w-full" onClick={() => void onValueChange(null)}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            <Trans>Remove avatar</Trans>
          </Button>
        ) : null}
        <p className="text-xs text-muted-foreground">
          <Trans>PNG, JPEG, or WebP. Maximum 5 MiB and 4096 × 4096.</Trans>
        </p>
      </TabsContent>
    </Tabs>
  );
}
