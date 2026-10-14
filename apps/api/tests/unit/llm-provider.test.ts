import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_POINTS, LlmProviderError } from '@stackpanel/sdk';
import type {
  LlmCallOptions,
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmModelInfo,
  LlmProvider,
} from '@stackpanel/sdk';
import {
  ConfiguredLlmProvider,
  ExtensionLlmProvider,
  LLM_CONFIG_SECRET_KEY,
  LLM_CONFIG_SETTING_KEY,
  readConfiguredLlmConfig,
  resolveLlmProvider,
} from '../../src/lib/llm-provider.ts';
import { encryptSecret } from '../../src/lib/crypto.ts';

const CALL_OPTIONS: LlmCallOptions = {
  callId: 'run_1:0',
  runId: 'run_1',
  actorId: 'user_1',
};

const CONFIGURED = {
  baseUrl: 'https://llm.example.com/v1',
  model: 'gpt-4o-mini',
  apiKey: 'sk-super-secret',
};

function stubProvider(id: string): LlmProvider {
  return {
    id,
    name: `provider ${id}`,
    listModels: async (): Promise<LlmModelInfo[]> => [{ id: 'm1', label: 'M1', supportsTools: true }],
    complete: async (): Promise<LlmCompletionResult> => ({
      model: 'm1',
      parts: [{ type: 'text', text: `from ${id}` }],
      stopReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costMinor: 0,
    }),
  };
}

/** A fetch double that records calls and replies with one fixed response. */
function fetchDouble(payload: unknown, init: ResponseInit = { status: 200 }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const OK_RESPONSE = {
  model: 'gpt-4o-mini',
  choices: [{ message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveLlmProvider', () => {
  it('prefers the extension point over the fallback config', async () => {
    const plugin = stubProvider('llm-gateway');
    const loadConfig = vi.fn(async () => CONFIGURED);

    const resolved = await resolveLlmProvider(
      { getExtensions: <T,>(pointId: string) => (pointId === EXTENSION_POINTS.llmProvider ? [plugin as T] : []) },
      { loadConfig },
    );

    expect(resolved).toBeInstanceOf(ExtensionLlmProvider);
    expect(resolved?.id).toBe('llm-gateway');
    // The fallback is not even read when a plugin registered the extension.
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('falls back to ConfiguredLlmProvider when no extension is registered', async () => {
    const resolved = await resolveLlmProvider(
      { getExtensions: <T,>() => [] as T[] },
      { loadConfig: async () => CONFIGURED, fetch: fetchDouble(OK_RESPONSE).impl },
    );

    expect(resolved).toBeInstanceOf(ConfiguredLlmProvider);
    expect(resolved?.id).toBe('configured');
  });

  it('returns null (does not throw, does not fabricate) when neither source exists', async () => {
    const resolved = await resolveLlmProvider(
      { getExtensions: <T,>() => [] as T[] },
      { loadConfig: async () => null },
    );

    expect(resolved).toBeNull();
  });
});

describe('ExtensionLlmProvider', () => {
  it('keeps the plugin id and passes LlmCallOptions through unchanged', async () => {
    const seen: LlmCallOptions[] = [];
    const plugin: LlmProvider = {
      ...stubProvider('llm-gateway'),
      complete: async (_request, options) => {
        seen.push(options);
        return {
          model: 'm1',
          parts: [{ type: 'text', text: 'ok' }],
          stopReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          costMinor: 0,
        };
      },
    };
    const wrapped = new ExtensionLlmProvider(plugin);

    await wrapped.complete({ model: 'm1', messages: [] }, CALL_OPTIONS);

    expect(wrapped.id).toBe('llm-gateway');
    // callId is the plugin's idempotency key for billing; it must survive intact.
    expect(seen).toEqual([CALL_OPTIONS]);
  });

  it('throws provider_unavailable when the plugin has no stream implementation', () => {
    const wrapped = new ExtensionLlmProvider(stubProvider('llm-gateway'));

    expect(() => wrapped.stream({ model: 'm1', messages: [] }, CALL_OPTIONS)).toThrowError(
      LlmProviderError,
    );
  });
});

describe('ConfiguredLlmProvider', () => {
  it('returns [] from listModels() when unconfigured and throws provider_unavailable on complete()', async () => {
    const provider = new ConfiguredLlmProvider({
      loadConfig: async () => null,
      fetch: fetchDouble(OK_RESPONSE).impl,
    });

    expect(await provider.listModels()).toEqual([]);

    await expect(provider.complete({ model: 'x', messages: [] }, CALL_OPTIONS)).rejects.toThrowError(
      /尚未配置模型/,
    );
    const error = await provider
      .complete({ model: 'x', messages: [] }, CALL_OPTIONS)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(LlmProviderError);
    expect((error as LlmProviderError).code).toBe('provider_unavailable');
    expect((error as LlmProviderError).retryable).toBe(false);
  });

  it.each([
    'http://127.0.0.1:11434/v1',
    'https://127.0.0.1/v1',
    'http://localhost:8080/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://192.168.1.10/v1',
    'http://llm.example.com/v1',
  ])('rejects non-public address %s before issuing any request', async (baseUrl) => {
    const { impl, calls } = fetchDouble(OK_RESPONSE);
    const provider = new ConfiguredLlmProvider({
      loadConfig: async () => ({ ...CONFIGURED, baseUrl }),
      fetch: impl,
    });

    const error = await provider
      .complete({ model: 'gpt-4o-mini', messages: [] }, CALL_OPTIONS)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(LlmProviderError);
    expect((error as LlmProviderError).code).toBe('provider_unavailable');
    expect((error as LlmProviderError).retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('maps the request to an OpenAI-compatible body and sends the key as a bearer header', async () => {
    const { impl, calls } = fetchDouble(OK_RESPONSE);
    const provider = new ConfiguredLlmProvider({ loadConfig: async () => CONFIGURED, fetch: impl });

    const request: LlmCompletionRequest = {
      model: 'gpt-4o-mini',
      system: '你是助手',
      messages: [
        { role: 'user', parts: [{ type: 'text', text: '读一下 a.txt' }] },
        {
          role: 'assistant',
          parts: [{ type: 'tool-call', id: 'call_1', name: 'fs_read', arguments: '{"path":"a.txt"}' }],
        },
        { role: 'tool', toolCallId: 'call_1', name: 'fs_read', parts: [{ type: 'tool-result', id: 'call_1', content: 'hello' }] },
      ],
      tools: [{ name: 'fs_read', description: '读文件', parameters: { type: 'object' } }],
      toolChoice: { name: 'fs_read' },
      maxTokens: 128,
      temperature: 0.2,
    };

    await provider.complete(request, CALL_OPTIONS);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe('https://llm.example.com/v1/chat/completions');
    expect(call?.init.method).toBe('POST');
    // Never follow redirects — a 302 could point at an internal address.
    expect(call?.init.redirect).toBe('error');
    expect((call?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer sk-super-secret',
    );
    expect(call?.init.signal).toBeDefined();

    const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.max_tokens).toBe(128);
    expect(body.temperature).toBe(0.2);
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'fs_read' } });
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'fs_read', description: '读文件', parameters: { type: 'object' } } },
    ]);
    expect(body.messages).toEqual([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '读一下 a.txt' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"a.txt"}' } }],
      },
      { role: 'tool', content: 'hello', tool_call_id: 'call_1', name: 'fs_read' },
    ]);
  });

  it('maps an OpenAI response (including tool_calls) back to kernel parts', async () => {
    const { impl } = fetchDouble({
      model: 'gpt-4o-mini',
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_9',
                type: 'function',
                function: { name: 'fs_read', arguments: '{"path":"a.txt"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    });
    const provider = new ConfiguredLlmProvider({ loadConfig: async () => CONFIGURED, fetch: impl });

    const result = await provider.complete(
      { model: 'gpt-4o-mini', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] },
      CALL_OPTIONS,
    );

    expect(result).toEqual({
      model: 'gpt-4o-mini',
      parts: [
        {
          type: 'tool-call',
          id: 'call_9',
          name: 'fs_read',
          // arguments stay the raw JSON string OpenAI handed back.
          arguments: '{"path":"a.txt"}',
        },
      ],
      stopReason: 'tool_calls',
      usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 },
      // Fallback billing is the site owner's own account: never a platform charge.
      costMinor: 0,
    });
  });

  it.each([
    ['stop', 'stop'],
    ['length', 'length'],
    ['content_filter', 'content_filter'],
    ['tool_calls', 'tool_calls'],
  ] as const)('maps finish_reason %s to stopReason %s', async (finishReason, expected) => {
    const { impl } = fetchDouble({
      model: 'gpt-4o-mini',
      choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: finishReason }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const provider = new ConfiguredLlmProvider({ loadConfig: async () => CONFIGURED, fetch: impl });

    const result = await provider.complete({ model: 'gpt-4o-mini', messages: [] }, CALL_OPTIONS);

    expect(result.stopReason).toBe(expected);
  });

  it('tolerates a response with no usage or no choices instead of crashing', async () => {
    const { impl } = fetchDouble({ model: 'gpt-4o-mini' });
    const provider = new ConfiguredLlmProvider({ loadConfig: async () => CONFIGURED, fetch: impl });

    const result = await provider.complete({ model: 'gpt-4o-mini', messages: [] }, CALL_OPTIONS);

    expect(result.parts).toEqual([]);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(result.stopReason).toBe('stop');
  });

  it('maps 429 to rate_limited/retryable and never leaks the key in the message', async () => {
    const { impl } = fetchDouble({ error: 'slow down' }, { status: 429, statusText: 'Too Many Requests' });
    const provider = new ConfiguredLlmProvider({ loadConfig: async () => CONFIGURED, fetch: impl });

    const error = (await provider
      .complete({ model: 'gpt-4o-mini', messages: [] }, CALL_OPTIONS)
      .catch((cause: unknown) => cause)) as LlmProviderError;

    expect(error.code).toBe('rate_limited');
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain(CONFIGURED.apiKey);
  });

  it('maps 500 to upstream_error/retryable and 400 to invalid_request/non-retryable', async () => {
    const providerFor = (status: number) =>
      new ConfiguredLlmProvider({
        loadConfig: async () => CONFIGURED,
        fetch: fetchDouble({ error: 'nope' }, { status }).impl,
      });

    const server = (await providerFor(500)
      .complete({ model: 'gpt-4o-mini', messages: [] }, CALL_OPTIONS)
      .catch((cause: unknown) => cause)) as LlmProviderError;
    const client = (await providerFor(400)
      .complete({ model: 'gpt-4o-mini', messages: [] }, CALL_OPTIONS)
      .catch((cause: unknown) => cause)) as LlmProviderError;

    expect([server.code, server.retryable]).toEqual(['upstream_error', true]);
    expect([client.code, client.retryable]).toEqual(['invalid_request', false]);
  });

  it('maps a network failure to upstream_error without echoing the request', async () => {
    const impl = (async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:443');
    }) as unknown as typeof fetch;
    const provider = new ConfiguredLlmProvider({ loadConfig: async () => CONFIGURED, fetch: impl });

    const error = (await provider
      .complete({ model: 'gpt-4o-mini', messages: [] }, CALL_OPTIONS)
      .catch((cause: unknown) => cause)) as LlmProviderError;

    expect(error.code).toBe('upstream_error');
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain('sk-super-secret');
  });

  it('honours LlmCallOptions.signal — an already-aborted signal reaches fetch as aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { impl, calls } = fetchDouble(OK_RESPONSE);
    const provider = new ConfiguredLlmProvider({ loadConfig: async () => CONFIGURED, fetch: impl });

    await provider.complete({ model: 'gpt-4o-mini', messages: [] }, {
      ...CALL_OPTIONS,
      signal: controller.signal,
    });

    const signal = calls[0]?.init.signal as AbortSignal;
    expect(signal.aborted).toBe(true);
  });
});

describe('readConfiguredLlmConfig', () => {
  /** Minimal Prisma double — no database involved. */
  function prismaDouble(value: unknown, ciphertext: string | null) {
    return {
      setting: { findUnique: async () => (value === undefined ? null : { value }) },
      secret: { findUnique: async () => (ciphertext === null ? null : { ciphertext }) },
    } as unknown as Parameters<typeof readConfiguredLlmConfig>[0];
  }

  it('decrypts the key stored in the Secret table and returns the usable config', async () => {
    const ciphertext = encryptSecret('sk-from-admin');
    const prisma = prismaDouble(
      { baseUrl: 'https://llm.example.com/v1/', model: 'gpt-4o-mini' },
      ciphertext,
    );

    await expect(readConfiguredLlmConfig(prisma)).resolves.toEqual({
      baseUrl: 'https://llm.example.com/v1/',
      model: 'gpt-4o-mini',
      apiKey: 'sk-from-admin',
    });
    expect(LLM_CONFIG_SETTING_KEY).toBe('agent.llm');
    expect(LLM_CONFIG_SECRET_KEY).toBe('agent.llm.apiKey');
  });

  it.each([
    ['no setting row', undefined, 'ciphertext'],
    ['blank baseUrl', { baseUrl: '', model: 'm' }, 'ciphertext'],
    ['blank model', { baseUrl: 'https://llm.example.com/v1', model: '  ' }, 'ciphertext'],
    ['no secret row', { baseUrl: 'https://llm.example.com/v1', model: 'm' }, null],
    ['blank secret', { baseUrl: 'https://llm.example.com/v1', model: 'm' }, ''],
  ])('returns null when %s', async (_label, value, ciphertext) => {
    const prisma = prismaDouble(value, ciphertext);
    await expect(readConfiguredLlmConfig(prisma)).resolves.toBeNull();
  });

  it('surfaces a corrupted ciphertext as a fault instead of silently reporting unconfigured', async () => {
    const prisma = prismaDouble(
      { baseUrl: 'https://llm.example.com/v1', model: 'm' },
      'not-a-valid-payload',
    );
    await expect(readConfiguredLlmConfig(prisma)).rejects.toThrowError(/密钥数据损坏/);
  });
});
