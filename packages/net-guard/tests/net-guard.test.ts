import { describe, expect, it } from 'vitest';
import {
  isPublicHttpUrl,
  isUnsafeHostname,
  isUnsafeIpAddress,
  resolvesToUnsafeAddress,
} from '../src/index.js';

describe('isUnsafeIpAddress', () => {
  it('flags private, loopback and link-local IPv4', () => {
    for (const address of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isUnsafeIpAddress(address), address).toBe(true);
    }
  });

  it('flags IPv4-mapped IPv6 in both dotted and hexadecimal form', () => {
    for (const address of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '::ffff:10.0.0.1',
      '::ffff:a00:1',
    ]) {
      expect(isUnsafeIpAddress(address), address).toBe(true);
    }
  });

  it('flags IPv6 loopback, ULA, link-local and multicast', () => {
    for (const address of ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1']) {
      expect(isUnsafeIpAddress(address), address).toBe(true);
    }
  });

  it('allows public addresses', () => {
    expect(isUnsafeIpAddress('1.1.1.1')).toBe(false);
    expect(isUnsafeIpAddress('8.8.8.8')).toBe(false);
    expect(isUnsafeIpAddress('2606:4700:4700::1111')).toBe(false);
    expect(isUnsafeIpAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('treats non-IP input as unsafe', () => {
    expect(isUnsafeIpAddress('example.com')).toBe(true);
    expect(isUnsafeIpAddress('')).toBe(true);
  });
});

describe('isUnsafeHostname', () => {
  it('rejects localhost and internal TLDs', () => {
    expect(isUnsafeHostname('localhost')).toBe(true);
    expect(isUnsafeHostname('api.localhost')).toBe(true);
    expect(isUnsafeHostname('db.internal')).toBe(true);
    expect(isUnsafeHostname('printer.local')).toBe(true);
  });

  it('rejects private IP literals and accepts public hostnames', () => {
    expect(isUnsafeHostname('10.0.0.5')).toBe(true);
    expect(isUnsafeHostname('[::1]')).toBe(true);
    expect(isUnsafeHostname('example.com')).toBe(false);
  });
});

describe('isPublicHttpUrl', () => {
  it('requires https by default and rejects credentials', () => {
    expect(isPublicHttpUrl('https://example.com/hook')).toBe(true);
    expect(isPublicHttpUrl('http://example.com/hook')).toBe(false);
    expect(isPublicHttpUrl('http://example.com/hook', { allowHttp: true })).toBe(true);
    expect(isPublicHttpUrl('https://user:pass@example.com/hook')).toBe(false);
  });

  it('rejects internal targets', () => {
    expect(isPublicHttpUrl('https://127.0.0.1/hook')).toBe(false);
    expect(isPublicHttpUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isPublicHttpUrl('https://[::ffff:7f00:1]/hook')).toBe(false);
    expect(isPublicHttpUrl('https://metadata.google.internal/')).toBe(false);
  });
});

describe('resolvesToUnsafeAddress', () => {
  // IP 字面量与内网主机名在本地即时判定，不触发 DNS。
  it('rejects private IP literals and internal hostnames', async () => {
    expect(await resolvesToUnsafeAddress('10.0.0.5')).toBe(true);
    expect(await resolvesToUnsafeAddress('192.168.1.1')).toBe(true);
    expect(await resolvesToUnsafeAddress('169.254.169.254')).toBe(true);
    expect(await resolvesToUnsafeAddress('[::1]')).toBe(true);
    expect(await resolvesToUnsafeAddress('localhost')).toBe(true);
    expect(await resolvesToUnsafeAddress('db.internal')).toBe(true);
  });

  it('accepts public IP literals without DNS resolution', async () => {
    expect(await resolvesToUnsafeAddress('93.184.216.34')).toBe(false);
    expect(await resolvesToUnsafeAddress('[2606:4700:4700::1111]')).toBe(false);
  });
});
