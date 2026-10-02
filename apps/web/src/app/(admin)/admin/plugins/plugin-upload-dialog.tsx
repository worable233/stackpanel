'use client';

import { useEffect, useState, useActionState } from 'react';
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
import {
  FrontendApplyProgress,
  isFrontendApplyActive,
  useFrontendApplyStatus,
} from './frontend-apply-progress';
import { useTranslator } from '@/i18n/provider';

/**
 * The upload form. Mounted fresh (via `key`) each time the dialog opens so the
 * previous run's action state and progress do not leak into a new upload.
 */
function UploadForm({ onClose }: { onClose: () => void }) {
  const t = useTranslator();
  const [state, action, pending] = useActionState<PluginActionState, FormData>(
    uploadPluginAction,
    {},
  );

  const requestedAt = state.requestedAt ?? null;
  const status = useFrontendApplyStatus(null, {
    enabled: Boolean(requestedAt),
    requestedAt,
  });
  const applying = Boolean(requestedAt) && isFrontendApplyActive(status);

  // Once the frontend apply settles, close the dialog.
  useEffect(() => {
    if (requestedAt && status && !isFrontendApplyActive(status)) {
      const timer = setTimeout(onClose, 1500);
      return () => clearTimeout(timer);
    }
  }, [requestedAt, status, onClose]);

  return (
    <form action={action} className="mt-4 flex flex-col gap-3">
      <div className="space-y-1">
        <Label htmlFor="plugin-zip">{t('upload.pluginFile')}</Label>
        <Input id="plugin-zip" name="file" type="file" accept=".zip" required />
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.ok && !state.frontendApply ? (
        <p className="text-sm text-muted-foreground">{state.message ?? t('apply.installed')}</p>
      ) : null}
      {requestedAt ? (
        status ? (
          <FrontendApplyProgress status={status} />
        ) : (
          <p className="text-sm text-muted-foreground">{t('apply.installingFrontend')}</p>
        )
      ) : null}
      <DialogFooter>
        <Button type="submit" disabled={pending || applying}>
          {pending ? t('upload.uploading') : applying ? t('upload.applying') : t('upload.submit')}
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
        <UploadForm key={runKey} onClose={() => handleOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
