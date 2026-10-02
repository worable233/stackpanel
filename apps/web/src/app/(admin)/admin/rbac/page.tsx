import type { PermissionGroupView, PermissionInfo } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { CreateGroupForm, PermissionGroupManager } from './permission-group-manager';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

export default async function AdminRbacPage() {
  const t = createTranslator(await getLocale());
  let groups: PermissionGroupView[] = [];
  let permissions: PermissionInfo[] = [];
  let error: string | null = null;
  try {
    const api = await getAuthedApiClient();
    const [groupsResult, permissionsResult] = await Promise.all([
      api.getPermissionGroups(),
      api.getPermissions(),
    ]);
    groups = groupsResult.groups;
    permissions = permissionsResult.permissions;
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  return (
    <main className="w-full space-y-6">
      <PageHeader
        title={t('admin.rbac.title')}
        description={t('admin.rbac.pageDescription')}
        actions={<CreateGroupForm />}
      />
      {error ? (
        <p className="text-sm text-destructive">
          {t('admin.rbac.serviceUnavailable', { error })}
        </p>
      ) : (
        <PermissionGroupManager groups={groups} permissions={permissions} />
      )}
    </main>
  );
}
