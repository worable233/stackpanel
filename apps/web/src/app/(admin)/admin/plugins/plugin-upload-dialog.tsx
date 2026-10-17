'use client';

import { useState, useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { uploadPluginAction, type PluginActionState } from '@/lib/plugin-actions';
import { useTranslator } from '@/i18n/provider';

/**
 * The upload form. Mounted fresh (via `key`) each time the dialog opens so the
 * previous run's action state does not leak into a new upload.
 */
function UploadForm() {
  const t = useTranslator();
  const [state, action, pending] = useActionState<PluginActionState, FormData>(
    uploadPluginAction,
    {},
  );

  return (
    <form action={action} className="mt-4 flex flex-col gap-3">
      <div className="space-y-1">
        <Label htmlFor="plugin-zip">{t('upload.pluginFile')}</Label>
        <Input id="plugin-zip" name="file" type="file" accept=".zip" required />
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.ok ? (
        <p className="text-sm text-muted-foreground">{state.message ?? t('plugin.installed')}</p>
      ) : null}
      <DialogFooter>
        <Button type="submit" disabled={pending}>
          {pending ? t('upload.uploading') : t('upload.submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Page-level action: upload a plugin ZIP. Rendered in the plugin page header. */
export function PluginUploadDialog() {
  const t = useTranslator();
  const [open, setOpen] = useState(false);
  // Bumped on each open so UploadForm remounts with a clean action state.
  const [runKey, setRunKey] = useState(0);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) setRunKey((key) => key + 1);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button />}>{t('upload.pluginTrigger')}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('upload.pluginTitle')}</DialogTitle>
          <DialogDescription>{t('upload.pluginDescription')}</DialogDescription>
        </DialogHeader>
        <UploadForm key={runKey} />
      </DialogContent>
    </Dialog>
  );
}
