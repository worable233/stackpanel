import { describe, expect, it } from 'vitest';
import { mapCatalogInstallError, CatalogMarketError } from '../../src/lib/market-catalog.ts';
import { KeyringError } from '../../src/distribution/keyring.ts';
import { CatalogConsumerError } from '../../src/distribution/catalog-consumer.ts';

/**
 * 安装失败的错误码要指向「操作者的下一步」。
 *
 * 线上事故里最常见的一类不是网络问题，而是**实例信任根不全**（v0.1.0/v0.1.1 的
 * 默认部署就是这样：数据目录里根本没有 `trust/keyring.json`）。以前它被归进
 * 「验签失败」，界面只说「签名、摘要或发布者与信任根不匹配」，运维无法从这句话
 * 推出「去补 keyring」。
 */
function installFailure(cause: unknown) {
  return mapCatalogInstallError(
    new CatalogMarketError('安装 market/demo 失败', [], 'fetch', cause),
  );
}

describe('mapCatalogInstallError: 信任根缺失', () => {
  it('keyId 不在信任根里 → market.trustRootMissing（不是验签失败）', () => {
    const mapped = installFailure(
      new CatalogConsumerError('信任根缺少 keyId pkg-2026-11（目录声明但内核不信任）', 'missing_key'),
    );
    expect(mapped?.code).toBe('market.trustRootMissing');
    // 422 而不是 502：这不是「上游坏了」，而是本实例配置缺东西。
    expect(mapped?.status).toBe(422);
    expect(mapped?.detail).toContain('pkg-2026-11');
  });

  it('发布者不在信任根 / 仓库未被允许也归为信任根问题', () => {
    expect(
      installFailure(new CatalogConsumerError('发布者 stackpanel 没有可用的签名 keyId', 'missing_key'))
        ?.code,
    ).toBe('market.trustRootMissing');
    expect(
      installFailure(
        new CatalogConsumerError('keyId pkg-2026-11 不允许签名仓库 evil/forks', 'repository_not_allowed'),
      )?.code,
    ).toBe('market.trustRootMissing');
  });

  it('嵌套在 cause 里的信任根问题同样识别（下载层会再包一层）', () => {
    const nested = Object.assign(new Error('download failed'), {
      cause: new CatalogConsumerError('信任根缺少 keyId pkg-2026-11', 'missing_key'),
    });
    expect(installFailure(nested)?.code).toBe('market.trustRootMissing');
  });

  it('真正的签名不匹配仍然是 market.signatureInvalid', () => {
    const mapped = installFailure(Object.assign(new Error('bad signature'), { kind: 'signature' }));
    expect(mapped?.code).toBe('market.signatureInvalid');
    expect(mapped?.status).toBe(502);
  });

  it('keyring 文件本身非法（KeyringError）按验签失败处理', () => {
    expect(installFailure(new KeyringError('信任根文件非法（/app/data/trust/keyring.json）'))?.code).toBe(
      'market.signatureInvalid',
    );
  });
});
