import { Suspense } from 'react';
import type { PermissionGroupView, PermissionInfo } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { DataSkeleton } from '@/components/data-skeletons';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';
import { CreateGroupForm, PermissionGroupManager } from './permission-group-manager';

export const dynamic = 'force-dynamic';

export default async function AdminRbacPage() {
  const t = createTranslator(await getLocale());
  return (
    <main className="w-full">
      <div className="mb-4">
        <PageHeader title={t('admin.rbac.title')} actions={<CreateGroupForm />} />
      </div>
      <Suspense fallback={<DataSkeleton variant="list" rows={4} rowHeight="rbac" />}>
        <RbacData />
      </Suspense>
    </main>
  );
}

async function RbacData() {
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

  return <PermissionGroupManager groups={groups} permissions={permissions} error={error} />;
}
