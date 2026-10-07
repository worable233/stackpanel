import type { PrismaClient } from '@stackpanel/db';
import type { MediaReferenceService } from '@stackpanel/sdk';

export class AttachmentReferenceService implements MediaReferenceService {
  constructor(private readonly db: PrismaClient) {}

  async register(input: {
    attachmentId: string;
    resourceType: string;
    resourceId: string;
    field?: string;
    ownerPluginId?: string;
  }): Promise<void> {
    const attachment = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "attachments" WHERE "id" = ${input.attachmentId} LIMIT 1
    `;
    if (attachment.length === 0) throw new Error(`附件不存在：${input.attachmentId}`);
    await this.db.$executeRaw`
      INSERT INTO "attachment_references" ("attachmentId", "resourceType", "resourceId", "field", "ownerPluginId")
      VALUES (${input.attachmentId}, ${input.resourceType}, ${input.resourceId}, ${input.field ?? ''}, ${input.ownerPluginId ?? null})
      ON CONFLICT ("attachmentId", "resourceType", "resourceId", "field") DO NOTHING
    `;
  }

  async list(attachmentId: string): Promise<Array<{
    resourceType: string;
    resourceId: string;
    field: string;
    createdAt: Date;
  }>> {
    return this.db.$queryRaw`
      SELECT "resourceType", "resourceId", "field", "createdAt"
      FROM "attachment_references"
      WHERE "attachmentId" = ${attachmentId}
      ORDER BY "createdAt" ASC
    `;
  }

  async unregister(input: {
    attachmentId: string;
    resourceType: string;
    resourceId: string;
    field?: string;
    ownerPluginId?: string;
  }): Promise<void> {
    await this.db.$executeRaw`
      DELETE FROM "attachment_references"
      WHERE "attachmentId" = ${input.attachmentId}
        AND "resourceType" = ${input.resourceType}
        AND "resourceId" = ${input.resourceId}
        AND "field" = ${input.field ?? ''}
        AND (${input.ownerPluginId ?? null}::text IS NULL OR "ownerPluginId" = ${input.ownerPluginId})
    `;
  }

  async unregisterResource(resourceType: string, resourceId: string, ownerPluginId?: string): Promise<void> {
    await this.db.$executeRaw`
      DELETE FROM "attachment_references"
      WHERE "resourceType" = ${resourceType} AND "resourceId" = ${resourceId}
        AND (${ownerPluginId ?? null}::text IS NULL OR "ownerPluginId" = ${ownerPluginId})
    `;
  }

  async isReferenced(attachmentId: string): Promise<boolean> {
    const rows = await this.db.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS(
        SELECT 1 FROM "attachment_references" WHERE "attachmentId" = ${attachmentId}
      ) AS "exists"
    `;
    return rows[0]?.exists === true;
  }
}
