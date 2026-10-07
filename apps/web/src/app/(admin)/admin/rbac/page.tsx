import type { PermissionGroupView, PermissionInfo } from '@stackpanel/sdk';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { PermissionGroupManager } from './permission-group-manager';

export const dynamic = 'force-dynamic';

export default async function AdminRbacPage() {
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
    <main className="w-full">
      <PermissionGroupManager groups={groups} permissions={permissions} error={error} />
    </main>
  );
}
