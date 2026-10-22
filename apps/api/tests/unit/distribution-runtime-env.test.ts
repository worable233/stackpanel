import { describe, expect, it } from 'vitest';
import {
  isContainerRuntime,
  localMarketSourcesAllowed,
  localSourcesDisabledReason,
} from '../../src/distribution/runtime-env.ts';

/**
 * 运行形态探测（§9/§10）。
 *
 * 关键语义：容器/生产形态下**绝不**放行本地来源，因为那等于允许从镜像里的源码
 * 目录安装插件，绕过签名目录。这里用注入的 probe 覆盖各判定分支。
 */

const noFiles = () => false;
const hasDockerMarker = (file: string) => file === '/.dockerenv';
const hasPodmanMarker = (file: string) => file === '/run/.containerenv';

describe('isContainerRuntime', () => {
  it('treats NODE_ENV=production as container/production form', () => {
    expect(isContainerRuntime({ NODE_ENV: 'production' }, noFiles)).toBe(true);
  });

  it('detects Docker and Podman markers', () => {
    expect(isContainerRuntime({ NODE_ENV: 'development' }, hasDockerMarker)).toBe(true);
    expect(isContainerRuntime({ NODE_ENV: 'development' }, hasPodmanMarker)).toBe(true);
  });

  it('detects a Kubernetes pod', () => {
    expect(isContainerRuntime({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, noFiles)).toBe(true);
  });

  it('treats a plain dev host as non-container', () => {
    expect(isContainerRuntime({ NODE_ENV: 'development' }, noFiles)).toBe(false);
  });
});

describe('localMarketSourcesAllowed', () => {
  it('allows local sources on a development host by default', () => {
    expect(localMarketSourcesAllowed({ NODE_ENV: 'development' }, noFiles)).toBe(true);
  });

  it('blocks local sources in production even when explicitly enabled', () => {
    // 安全边界优先于配置偏好：容器里 `on` 不生效。
    expect(
      localMarketSourcesAllowed(
        { NODE_ENV: 'production', STACKPANEL_MARKET_LOCAL_SOURCES: 'on' },
        noFiles,
      ),
    ).toBe(false);
  });

  it('blocks local sources when a container marker is present', () => {
    expect(
      localMarketSourcesAllowed(
        { NODE_ENV: 'development', STACKPANEL_MARKET_LOCAL_SOURCES: 'on' },
        hasDockerMarker,
      ),
    ).toBe(false);
  });

  it('lets a developer opt out explicitly on a non-container host', () => {
    expect(
      localMarketSourcesAllowed(
        { NODE_ENV: 'development', STACKPANEL_MARKET_LOCAL_SOURCES: 'off' },
        noFiles,
      ),
    ).toBe(false);
  });

  it('gives an actionable reason when local sources are blocked', () => {
    expect(localSourcesDisabledReason()).toMatch(/容器|生产/);
    expect(localSourcesDisabledReason()).toMatch(/STACKPANEL_MARKET_LOCAL_SOURCES/);
  });
});
