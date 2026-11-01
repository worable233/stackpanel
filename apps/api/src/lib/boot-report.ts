/**
 * 启动自检快照：让「这个容器到底跑的是哪个版本、信任根齐不齐、真实 IP 认不认得出」
 * 这类问题不必靠行为观察来猜。
 *
 * v0.1.0/v0.1.1 的线上排障里，运维分辨当前镜像版本的唯一办法是「看首页有没有样式」
 * （因为镜像里没有版本标识）；真实客户端 IP 是否解析正确也只能翻日志猜。这里把启动
 * 时已知的事实固定下来，由 `GET /version` 暴露。
 */
import { KERNEL_API_VERSION } from '@stackpanel/spec';

export interface TrustSummary {
  /** 各用途可用（未撤销、未过期）的公钥数量。 */
  catalogKeys: number;
  packageKeys: number;
  kernelKeys: number;
  /** `PACKAGE_SIGNATURE_REQUIRED` 的当前生效值。 */
  signatureRequired: boolean;
  /** `trust/keyring.json` 的实际路径，便于运维定位。 */
  keyringPath: string;
}

export interface BootReport {
  version: string;
  apiVersion: string;
  /** 产物 `RELEASE.json` 记录的提交号；源码运行时为 null。 */
  commit: string | null;
  builtAt: string | null;
  startedAt: string;
  /** 生效的反代信任配置（`API_TRUST_PROXY` 归一化后的描述）。 */
  trustProxy: string;
  trust: TrustSummary;
}

let current: BootReport | null = null;

export function setBootReport(report: BootReport): void {
  current = report;
}

export function getBootReport(): BootReport | null {
  return current;
}

/** `/version` 的兜底（例如单元测试里没有跑启动流程）。 */
export function fallbackBootReport(version: string): BootReport {
  return {
    version,
    apiVersion: KERNEL_API_VERSION,
    commit: null,
    builtAt: null,
    startedAt: new Date().toISOString(),
    trustProxy: 'unknown',
    trust: {
      catalogKeys: 0,
      packageKeys: 0,
      kernelKeys: 0,
      signatureRequired: false,
      keyringPath: '',
    },
  };
}
