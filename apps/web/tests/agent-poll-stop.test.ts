import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 关闭抽屉必须停止运行轮询。
 *
 * `pollRun` 只在 `runGeneration` 变化时退出，而那个计数只在**切换回合**时自增。
 * 关抽屉不碰它，于是一条后台运行的轮询会一直跑到 150 次上限（约 5 分钟），
 * 每 2 秒发一个 `/runs/:id`。用户早就把抽屉关了，网络面板里还在响，服务端也
 * 照样被敲——这是纯浪费，而且用户完全无法让它停下（只能刷新页面）。
 *
 * 这条用例是**结构断言**：`pollRun` 的循环必须同时检查「抽屉是否还开着」。
 * 行为测试要跑真实计时器 5 分钟，不现实；而这里要防的正是「有人把这个条件
 * 删掉」这种回归。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  path.resolve(here, '../src/hooks/use-agent-conversations.ts'),
  'utf8',
);

describe('useAgentConversations 的轮询生命周期', () => {
  it('exposes an openRef that tracks the drawer', () => {
    expect(source).toMatch(/const openRef = useRef\(open\)/);
    expect(source).toMatch(/openRef\.current = open/);
  });

  it('invalidates the running generation when the drawer closes', () => {
    // 关抽屉后上一轮循环必须自己退出，否则重新打开会出现两个循环同时写 run。
    expect(source).toMatch(/if \(!open\) runGeneration\.current \+= 1/);
  });

  it('checks the drawer in every poll iteration, not only the generation', () => {
    const poll = source.slice(source.indexOf('async function pollRun'));
    const body = poll.slice(0, poll.indexOf('async function loadMore'));
    const guards = body.match(/generation !== runGeneration\.current \|\| !openRef\.current/g) ?? [];
    // 循环开头一次、await 之后一次、请求回来之后一次。
    expect(guards.length).toBeGreaterThanOrEqual(3);
    // 不允许出现只检查 generation 的漏网分支。
    expect(body).not.toMatch(/if \(generation !== runGeneration\.current\) return;/);
  });
});
