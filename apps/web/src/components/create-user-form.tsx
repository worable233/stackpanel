'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { PermissionGroupInfo } from '@stackpanel/sdk';
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
import { createUserAction, type CreateUserResult } from '@/lib/user-actions';
import { useTranslator } from '@/i18n/provider';

function StatusMessage({ state }: { state: CreateUserResult | null }) {
  if (!state) return null;
  if (state.error) {
    return <span className="text-sm text-destructive">{state.error}</span>;
  }
  if (state.ok) {
    return <span className="text-sm text-muted-foreground">{state.message}</span>;
  }
  return null;
}

/** 添加用户弹窗：邮箱必填，密码留空自动生成（仅显示一次）。 */
export function CreateUserForm({ groups }: { groups: PermissionGroupInfo[] }) {
  const router = useRouter();
  const t = useTranslator();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<CreateUserResult | null>(null);
  const [open, setOpen] = useState(false);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(
    new Set(['group_user']),
  );
  const [status, setStatus] = useState<'ACTIVE' | 'DISABLED'>('ACTIVE');

  function toggleGroup(id: string) {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function reset() {
    setState(null);
    setSelectedGroups(new Set(['group_user']));
    setStatus('ACTIVE');
  }

  function submit(formData: FormData) {
    const email = formData.get('email');
    const password = formData.get('password');
    if (typeof email !== 'string' || !email.trim()) {
      setState({ error: t('createUser.emailRequired') });
      return;
    }
    if (typeof password === 'string' && password.length > 0 && password.length < 8) {
      setState({ error: t('createUser.passwordTooShort') });
      return;
    }
    setState(null);
    startTransition(async () => {
      const result = await createUserAction({
        email,
        ...(typeof password === 'string' && password ? { password } : {}),
        status,
        groupIds: [...selectedGroups],
      });
      setState(result);
      if (result.ok) router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button variant="outline" />}>
        {t('createUser.trigger')}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('createUser.title')}</DialogTitle>
          <DialogDescription>{t('createUser.description')}</DialogDescription>
        </DialogHeader>

        <form action={submit} className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-user-email">{t('createUser.email')}</Label>
            <Input
              id="new-user-email"
              name="email"
              type="email"
              required
              maxLength={191}
              placeholder="user@example.com"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-user-password">{t('createUser.password')}</Label>
            <Input
              id="new-user-password"
              name="password"
              type="text"
              maxLength={72}
              placeholder={t('createUser.passwordPlaceholder')}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label>{t('createUser.groups')}</Label>
            <div className="flex flex-wrap gap-2">
              {groups.map((group) => (
                <label
                  key={group.id}
                  className="flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    checked={selectedGroups.has(group.id)}
                    onChange={() => toggleGroup(group.id)}
                    className="size-4 accent-primary"
                  />
                  <span>{group.name}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-user-status">{t('createUser.status')}</Label>
            <select
              id="new-user-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as 'ACTIVE' | 'DISABLED')}
              className="h-8 rounded-md border bg-background px-2 text-sm"
            >
              <option value="ACTIVE">{t('createUser.statusActive')}</option>
              <option value="DISABLED">{t('createUser.statusDisabled')}</option>
            </select>
          </div>

          {state?.ok && state.generatedPassword ? (
            <div className="rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm">
              <span className="font-medium">{t('createUser.generatedPassword')}</span>
              <code className="mt-1 block rounded bg-background px-1.5 py-0.5 font-mono">
                {state.generatedPassword}
              </code>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? t('createUser.creating') : t('createUser.submit')}
            </Button>
            <StatusMessage state={state} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
