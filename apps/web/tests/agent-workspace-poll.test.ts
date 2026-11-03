import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 工作区页面在运行终态后必须停止轮询。
 *
 * 以前的条件是「页面有 runId」就每 5 秒 `refresh()`，而 `refresh()` 一次发三个
 * 请求（`status` + `approvals` + `runs/:id`）。运行到了 DONE / FAILED /
 * CANCELLED 之后这些数据不会再变，可页面一直开着就一直发——每小时 2160 个请求，
 * 纯粹白烧服务端与浏览器。
 *
 * 结构断言：轮询的续期条件里必须有「非终态」这一项。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  path.resolve(here, '../src/components/agent-workspace.tsx'),
  'utf8',
);

describe('AgentWorkspace 的轮询生命周期', () => {
  it('derives a terminal flag from the run status', () => {
    expect(source).toMatch(/const terminal = run \? \[[^\]]*'DONE'[^\]]*\]\.includes\(run\.status\) : false/);
  });

  it('stops rescheduling once the run is terminal', () => {
    // 续期条件：active && runId && !terminal
    expect(source).toMatch(/if \(active && runId && !terminal\) timer = setTimeout/);
  });

  it('re-runs the effect when the terminal flag flips', () => {
    // 依赖里必须有 terminal，否则终态后定时器仍按旧闭包续期。
    expect(source).toMatch(/\}, \[refresh, failText, runId, terminal\]\);/);
  });
});
