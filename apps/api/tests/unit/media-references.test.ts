import { describe, expect, it } from 'vitest';
import { AttachmentReferenceService } from '../../src/media/references.ts';

type Call = { values: unknown[] };

function fakeDb(attachmentExists = true): { db: never; queries: Call[]; executions: Call[] } {
  const queries: Call[] = [];
  const executions: Call[] = [];
  const db = {
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ values });
      return attachmentExists ? [{ id: values[0] }] : [];
    },
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      executions.push({ values });
      return 1;
    },
  } as never;
  return { db, queries, executions };
}

describe('AttachmentReferenceService', () => {
  it('registers with the plugin owner scope and makes duplicate registration idempotent', async () => {
    const fake = fakeDb();
    const service = new AttachmentReferenceService(fake.db);
    const input = {
      attachmentId: 'att-1',
      resourceType: 'product',
      resourceId: 'product-1',
      field: 'hero',
      ownerPluginId: 'store-a',
    };

    await service.register(input);
    await service.register(input);

    expect(fake.queries).toHaveLength(2);
    expect(fake.executions).toHaveLength(2);
    expect(fake.executions[0]?.values).toEqual(['att-1', 'product', 'product-1', 'hero', 'store-a']);
  });

  it('passes the owner scope to unregister so one plugin cannot remove another plugin reference', async () => {
    const fake = fakeDb();
    const service = new AttachmentReferenceService(fake.db);

    await service.unregister({
      attachmentId: 'att-1',
      resourceType: 'product',
      resourceId: 'product-1',
      field: 'hero',
      ownerPluginId: 'store-a',
    });

    expect(fake.executions[0]?.values).toEqual(['att-1', 'product', 'product-1', 'hero', 'store-a', 'store-a']);
  });

  it('rejects references to missing attachments before writing an index row', async () => {
    const fake = fakeDb(false);
    const service = new AttachmentReferenceService(fake.db);

    await expect(service.register({
      attachmentId: 'missing',
      resourceType: 'product',
      resourceId: 'product-1',
      ownerPluginId: 'store-a',
    })).rejects.toThrow('附件不存在');
    expect(fake.executions).toHaveLength(0);
  });
});
