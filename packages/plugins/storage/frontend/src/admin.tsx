'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  Input,
  Label,
  PageHeader,
  SectionTitle,
  Select,
} from '@stackpanel/ui';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { Database, HardDrive, Settings } from 'lucide-react';
import type { AdminConfigData } from './schemas';

const KIND_OPTIONS = [
  { value: 'env', label: '跟随环境变量（不启用插件后端）' },
  { value: 'local', label: '服务器本地盘' },
  { value: 's3', label: 'S3 兼容存储（MinIO / R2 / OSS / AWS）' },
];

function ConfigForm({
  config,
  action,
}: {
  config: AdminConfigData['config'];
  action?: ((formData: FormData) => Promise<void>) | undefined;
}): ReactElement {
  const [kind, setKind] = useState(config.kind);

  if (!action) {
    return (
      <Card>
        <CardHeader>
          <SectionTitle icon={<Settings />}>存储配置</SectionTitle>
          <CardDescription>当前无法保存配置（缺少权限或未登录）。</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<Settings />}>存储配置</SectionTitle>
        <CardDescription>
          选择对象存储后端。启用后，媒体/品牌/备份的新对象统一走此后端；历史对象仍可读回。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="cfg-kind">后端类型</Label>
            <Select
              id="cfg-kind"
              name="kind"
              defaultValue={config.kind}
              onChange={(event) => setKind(event.target.value as typeof kind)}
            >
              {KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>

          {kind === 'env' ? (
            <p className="text-sm text-muted-foreground sm:col-span-2">
              当前由内核环境变量（STORAGE_DRIVER 等）决定存储位置，本插件不接管。
            </p>
          ) : null}

          {kind === 'local' ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cfg-local-root">本地根目录</Label>
                <Input
                  id="cfg-local-root"
                  name="localRoot"
                  defaultValue={config.localRoot}
                  placeholder="留空则用数据目录下的 storage"
                  maxLength={1024}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cfg-public-base">公开访问前缀</Label>
                <Input
                  id="cfg-public-base"
                  name="publicBaseUrl"
                  defaultValue={config.publicBaseUrl}
                  placeholder="/storage"
                  maxLength={2048}
                />
              </div>
            </>
          ) : null}

          {kind === 's3' ? (
            <>
              {!config.secretsAvailable ? (
                <p
                  role="status"
                  className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-700 dark:text-amber-300 sm:col-span-2"
                >
                  密钥存储不可用：请先在内核配置 SETTINGS_ENCRYPTION_KEY，否则无法保存访问密钥。
                </p>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cfg-s3-endpoint">端点（Endpoint）</Label>
                <Input
                  id="cfg-s3-endpoint"
                  name="s3Endpoint"
                  defaultValue={config.s3Endpoint}
                  placeholder="https://minio.example.com 或留空走 AWS"
                  maxLength={2048}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cfg-s3-region">区域（Region）</Label>
                <Input
                  id="cfg-s3-region"
                  name="s3Region"
                  defaultValue={config.s3Region}
                  maxLength={64}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cfg-s3-bucket">存储桶（Bucket）</Label>
                <Input
                  id="cfg-s3-bucket"
                  name="s3Bucket"
                  defaultValue={config.s3Bucket}
                  maxLength={255}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cfg-s3-style">寻址方式</Label>
                <Select
                  id="cfg-s3-style"
                  name="s3ForcePathStyle"
                  defaultValue={config.s3ForcePathStyle ? 'true' : 'false'}
                >
                  <option value="true">Path-style（MinIO / 自建网关）</option>
                  <option value="false">Virtual-hosted（AWS / R2）</option>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cfg-s3-access">Access Key ID</Label>
                <Input
                  id="cfg-s3-access"
                  name="accessKeyId"
                  autoComplete="off"
                  maxLength={255}
                  placeholder={config.hasCredentials ? '已配置（留空则不修改）' : ''}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cfg-s3-secret">Secret Access Key</Label>
                <Input
                  id="cfg-s3-secret"
                  name="secretAccessKey"
                  type="password"
                  autoComplete="off"
                  maxLength={255}
                  placeholder={config.hasCredentials ? '已配置（留空则不修改）' : ''}
                />
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="cfg-s3-public">公开访问基址</Label>
                <Input
                  id="cfg-s3-public"
                  name="publicBaseUrl"
                  defaultValue={config.publicBaseUrl}
                  placeholder="留空则由端点与桶推导"
                  maxLength={2048}
                />
              </div>
            </>
          ) : null}

          <div className="flex items-end sm:col-span-2">
            <Button type="submit">保存配置</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function StorageAdminPage(props: AdminPageComponentProps): ReactElement {
  const data = props.data.storageConfig as AdminConfigData | undefined;
  const config = data?.config;

  return (
    <main className="flex w-full flex-col gap-8">
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Database className="size-4" aria-hidden="true" />
            <HardDrive className="size-4" aria-hidden="true" />
          </span>
        }
        title="存储"
      />

      {config ? (
        <ConfigForm config={config} action={props.actions?.['storage.save-config']} />
      ) : (
        <p className="text-sm text-muted-foreground">存储配置暂时无法加载，请刷新重试。</p>
      )}
    </main>
  );
}

export const adminPages = {
  'admin/storage': StorageAdminPage,
} as const;
