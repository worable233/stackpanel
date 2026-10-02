'use client';

import { useActionState } from 'react';
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
import { uploadThemeAction, type ThemeActionState } from '@/lib/theme-actions';
import { useTranslator } from '@/i18n/provider';

/** Page-level action: upload a theme ZIP. Rendered in the theme page header. */
export function ThemeUploadDialog() {
  const t = useTranslator();
  const [state, action, pending] = useActionState<ThemeActionState, FormData>(
    uploadThemeAction,
    {},
  );

  return (
    <Dialog>
      <DialogTrigger render={<Button />}>{t('upload.themeTrigger')}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('upload.themeTitle')}</DialogTitle>
          <DialogDescription>{t('upload.themeDescription')}</DialogDescription>
        </DialogHeader>
        <form action={action} className="mt-4 flex flex-col gap-3">
          <div className="space-y-1">
            <Label htmlFor="theme-zip">{t('upload.themeFile')}</Label>
            <Input id="theme-zip" name="file" type="file" accept=".zip" required />
          </div>
          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          {state.ok ? (
            <p className="text-sm text-muted-foreground">{t('upload.themeInstalled')}</p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? t('upload.uploading') : t('upload.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
