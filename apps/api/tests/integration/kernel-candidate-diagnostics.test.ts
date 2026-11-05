import { describe, expect, it } from 'vitest';
import {
  describeKernelCandidateFailures,
  type KernelCandidatesResult,
} from '../../src/updates/runtime.ts';

/**
 * 内核候选诊断的可读文案。
 *
 * 背景（真实隐患）：`loadKernelCandidates` 早期是裸 `catch {}`，于是
 *
 *   - 信任根缺 `kernel-2026-11` 这把 key
 *   - 清单 / 签名资产 404
 *   - 验签失败
 *   - 网络不通
 *
 * 全部收敛成上游一句 `incompatible_kernel: 没有可升级的内核版本`。一个明明在
 * 0.1.2、目录里写着 0.1.3 的实例，界面只会说「没有可升级的内核版本」—— 看上去
 * 和「已经是最新」一模一样，运维完全无从下手（实测：本地数据目录缺
 * `trust/keyring.json` 时就是这个表现）。
 *
 * 现在失败原因会进 block detail 与 warn 日志。这几条用例钉住「什么时候该说话」
 * 与「什么时候不该说话」。
 */
describe('内核候选失败诊断', () => {
  const result = (partial: Partial<KernelCandidatesResult>): KernelCandidatesResult => ({
    manifests: [],
    failures: [],
    noRefs: false,
    ...partial,
  });

  it('全部取到时不产生诊断（不制造噪音）', () => {
    const message = describeKernelCandidateFailures(
      result({ manifests: [{ version: '0.1.3' } as never] }),
    );
    expect(message).toBeUndefined();
  });

  it('目录本来就没有内核引用时不产生诊断（那是配置结果，不是错误）', () => {
    const message = describeKernelCandidateFailures(result({ noRefs: true }));
    expect(message).toBeUndefined();
  });

  it('全部失败时说明原因，并带上版本与 keyId', () => {
    const message = describeKernelCandidateFailures(
      result({
        failures: [
          {
            version: '0.1.3',
            keyId: 'kernel-2026-11',
            reason: '内核清单签名校验失败：内核清单签名者未被信任：kernel-2026-11',
          },
        ],
      }),
    );
    expect(message).toBeDefined();
    expect(message).toContain('全部取回/验签失败');
    expect(message).toContain('0.1.3');
    expect(message).toContain('kernel-2026-11');
    // 真正的原因必须透传，不能被改写成泛泛的一句。
    expect(message).toContain('签名者未被信任');
  });

  it('部分失败时说明已取到几个（其余仍可用）', () => {
    const message = describeKernelCandidateFailures(
      result({
        manifests: [{ version: '0.1.2' } as never],
        failures: [{ version: '0.1.3', keyId: 'kernel-2026-11', reason: '网络不通' }],
      }),
    );
    expect(message).toContain('部分内核清单不可用');
    expect(message).toContain('已取到 1 个');
    expect(message).toContain('网络不通');
  });

  it('多条失败逐条列出（不吞掉后面的）', () => {
    const message = describeKernelCandidateFailures(
      result({
        failures: [
          { version: '0.1.3', keyId: 'k1', reason: '原因一' },
          { version: '0.1.2', keyId: 'k2', reason: '原因二' },
        ],
      }),
    );
    expect(message).toContain('原因一');
    expect(message).toContain('原因二');
  });
});
