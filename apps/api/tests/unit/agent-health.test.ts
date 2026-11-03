import { describe, expect, it, vi } from 'vitest';

/**
 * `/ready` 的 `agent.llmConfigured` 必须与真实闸门同口径。
 *
 * 线上两种误报，方向相反、都很难查：
 *
 * - **假绿**：管理员填了 `baseUrl` + `model` 但保存密钥失败（或密钥后来被删）。
 *   `Setting['agent.llm']` 里两个字符串都在，旧实现据此报「已配置」，而
 *   `resolveLlmProvider()` 读不到 Secret 就返回 `null` —— 每一次运行都在建
 *   run 之前抛 `agent.llm_unconfigured`。运维拿着「一切正常」的探针去查权限、
 *   查网络、查网关，唯独不会怀疑密钥根本没存进去。
 * - **假红**：插件通过 `llmProvider` 扩展点提供模型时压根没有 `agent.llm` 这个
 *   设置，旧实现报「未配置」，实际完全可用。
 *
 * 这里用真实的 `resolveLlmProvider` 配合假的 Prisma/runtime，验证
 * `readAgentHealth` 的结论与它一致。
 */

const settings = new Map<string, unknown>();
const secrets = new Map<string, string>();

vi.mock('../../src/plugins/prisma.ts', () => ({
  getPrisma: () => ({
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null,
    },
    secret: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        secrets.has(where.key) ? { key: where.key, ciphertext: secrets.get(where.key) } : null,
    },
    agentRun: {
      findFirst: async () => null,
      count: async () => 0,
    },
  }),
}));

vi.mock('../../src/lib/crypto.ts', () => ({
  decryptSecret: (ciphertext: string) => ciphertext.replace(/^enc:/, ''),
  encryptSecret: (plain: string) => `enc:${plain}`,
  isSecretsEnabled: () => true,
}));

const { readAgentHealth } = await import('../../src/routes/health.ts');
const { LLM_CONFIG_SETTING_KEY, LLM_CONFIG_SECRET_KEY } = await import(
  '../../src/lib/llm-provider.ts'
);

/** A runtime with no `llmProvider` extension. */
const noPlugins = { getExtensions: () => [] } as never;

function configure(value: unknown, secret?: string): void {
  settings.clear();
  secrets.clear();
  if (value !== undefined) settings.set(LLM_CONFIG_SETTING_KEY, value);
  if (secret !== undefined) secrets.set(LLM_CONFIG_SECRET_KEY, secret);
}

describe('readAgentHealth 的 llmConfigured', () => {
  it('reports configured when the fallback address, model and secret are all present', async () => {
    configure({ baseUrl: 'https://gw.example/v1', model: 'gpt-x' }, 'enc:sk-live');
    const health = await readAgentHealth(noPlugins);
    expect(health.llmConfigured).toBe(true);
    expect(health.llmProvider).toBe('configured');
  });

  it('reports NOT configured when the address and model exist but the secret is missing', async () => {
    // 这正是「假绿」：Setting 完整、密钥缺失。旧实现会报 true。
    configure({ baseUrl: 'https://gw.example/v1', model: 'gpt-x' });
    const health = await readAgentHealth(noPlugins);
    expect(health.llmConfigured).toBe(false);
    expect(health.llmProvider).toBeNull();
  });

  it('reports NOT configured when the stored secret is blank', async () => {
    configure({ baseUrl: 'https://gw.example/v1', model: 'gpt-x' }, 'enc:   ');
    expect((await readAgentHealth(noPlugins)).llmConfigured).toBe(false);
  });

  it('reports configured when a plugin supplies the provider and no setting exists', async () => {
    // 「假红」：插件提供模型时没有 `agent.llm` 设置。
    configure(undefined);
    const withPlugin = {
      getExtensions: () => [
        {
          id: 'gateway',
          name: 'Gateway',
          listModels: async () => [],
          complete: async () => {
            throw new Error('not called');
          },
        },
      ],
    } as never;
    const health = await readAgentHealth(withPlugin);
    expect(health.llmConfigured).toBe(true);
    expect(health.llmProvider).toBe('gateway');
  });

  it('does not throw when the provider cannot be resolved (corrupt ciphertext)', async () => {
    // 探针不能因为密钥损坏就 500：它要传达的是「Agent 不可用」。
    configure({ baseUrl: 'https://gw.example/v1', model: 'gpt-x' }, 'boom');
    const runtime = {
      getExtensions: () => {
        throw new Error('runtime exploded');
      },
    } as never;
    await expect(readAgentHealth(runtime)).resolves.toMatchObject({ llmConfigured: false });
  });

  it('still reports the enabled switch and run counters', async () => {
    settings.clear();
    settings.set('agent.enabled', { enabled: true });
    secrets.clear();
    const health = await readAgentHealth(noPlugins);
    expect(health.enabled).toBe(true);
    expect(health.runCount).toBe(0);
    expect(health.lastRunAt).toBeNull();
  });
});
