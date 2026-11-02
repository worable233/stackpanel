import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentErrorFromBody, agentErrorText } from '@/lib/agent-errors';
import { turnTraceKind } from '@/components/agent-chat-panel';

/**
 * 「消息已保存 · 尚未启动 Agent 执行」—— 用户配好 Agent 后仍然看到这句话。
 *
 * 复现结论：**后端没问题**。`POST /api/v1/agent/workspace/runs` 明确返回
 * 503 `agent.llm_unconfigured` + 「尚未配置模型：请在后台设置中填写接口地址、
 * 密钥与模型名」。前端 `startRun` 也确实把它转成了错误。
 *
 * 真正的问题在**渲染层**：抽屉里每个用户消息下面那行文字是一个二元表达式——
 * 有 `history.run` 就显示运行轨迹，没有就显示「消息已保存」。运行**失败到
 * 根本没建起来**（503、网络错误、模型未配置）时 `run` 恒为 null，于是界面
 * 展示的是「消息已保存 · 尚未启动 Agent 执行」——一句在正常保存路径下才成立
 * 的中性文案，恰好把「为什么没跑」彻底盖住。错误文本被塞进了 `error`，而
 * `error` 只在抽屉**顶部**渲染，用户根本不会往那儿看（它的默认语义是
 * 「对话加载失败」）。
 *
 * 这些断言锁的是「失败原因必须能到达用户」这条契约。
 */
describe('agent run failure must reach the user', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('carries the kernel detail for agent.llm_unconfigured', () => {
    // 内核实际返回的形状（实测抓取）。
    const body = {
      type: 'https://errors.stackpanel.dev/agent/llm_unconfigured',
      title: 'Service Unavailable',
      status: 503,
      code: 'agent.llm_unconfigured',
      detail: '尚未配置模型：请在后台设置中填写接口地址、密钥与模型名',
      instance: '/api/v1/agent/workspace/runs',
    };
    const error = agentErrorFromBody(body);
    expect(error.code).toBe('agent.llm_unconfigured');
    expect(error.message).toContain('尚未配置模型');
  });

  it('prefers localized copy for a known code over the server prose', () => {
    // `error.agent.llm_unconfigured` 存在于词表里，所以用户看到的是本地说法。
    const t = (key: string) =>
      key === 'error.agent.llm_unconfigured' ? '尚未配置模型服务，请联系管理员' : key;
    const text = agentErrorText(
      t,
      agentErrorFromBody({ code: 'agent.llm_unconfigured' }),
      '无法启动 Agent 执行',
    );
    expect(text).toBe('尚未配置模型服务，请联系管理员');
  });

  it('falls back to the kernel detail when no local copy exists', () => {
    // 新 code 在老前端上出现时，不能只剩一句「无法启动 Agent 执行」。
    const t = (key: string) => key;
    const text = agentErrorText(
      t,
      agentErrorFromBody({ code: 'agent.some_future_code', detail: '运行被策略拒绝' }),
      '无法启动 Agent 执行',
    );
    expect(text).toBe('运行被策略拒绝');
  });
});

/**
 * 渲染层的优先级：失败原因必须排在「消息已保存」之前。
 *
 * 这是**判定本身**，不是字符串顺序。后者是废门禁：把条件改成
 * `false && runError` 它照样绿。
 */
describe('agent drawer renders the run failure where the user is looking', () => {
  it('reports a failed start even though there is no run object', () => {
    // 事故现场：503 导致 run 恒为 null，只有 runError 有值。
    expect(turnTraceKind({ isLatest: true, hasRun: false, hasRunError: true })).toBe('failed');
  });

  it('prefers the live run trace when a run exists', () => {
    expect(turnTraceKind({ isLatest: true, hasRun: true, hasRunError: false })).toBe('run');
    // 有运行结果时，历史回合的失败不再重要（只挂在最新一条下面）。
    expect(turnTraceKind({ isLatest: false, hasRun: true, hasRunError: true })).toBe('run');
  });

  it('says 已保存 only when nothing was asked to run', () => {
    expect(turnTraceKind({ isLatest: true, hasRun: false, hasRunError: false })).toBe('saved');
    // 历史回合不能重复挂上一回合的错误。
    expect(turnTraceKind({ isLatest: false, hasRun: false, hasRunError: true })).toBe('saved');
  });

  it('does not route a run-start failure into the conversation-level error', () => {
    // `setError` 把文案送到抽屉顶部，那里的语义是“对话加载失败”；运行没能
    // 发起不是那个意思，也不在用户的视线里。
    const hook = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../src/hooks/use-agent-conversations.ts',
      ),
      'utf8',
    );
    const startRun = hook.slice(hook.indexOf('async function startRun'));
    const catchBlock = startRun.slice(startRun.indexOf('} catch'));
    expect(catchBlock.slice(0, 400)).toContain('setRunError');
    expect(catchBlock.slice(0, 400)).not.toContain('setError');
  });
});
