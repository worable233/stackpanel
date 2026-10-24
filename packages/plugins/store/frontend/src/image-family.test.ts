import { describe, expect, it } from 'vitest';
import { imageFamily } from '../../../../ui/src/image-family';
describe('provider image grouping', () => {
  it.each([
    ['Debian13-x86', 'debian'],
    ['UBUNTU_24.04', 'ubuntu'],
    ['Alma Linux 9', 'almalinux'],
    ['Rocky-linux-8.10', 'rocky'],
    ['Win_Server_2022', 'windows'],
    ['openSUSE Leap 15', 'opensuse'],
    ['Red Hat Enterprise Linux 9', 'rhel'],
    ['Custom appliance v1', 'other'],
    ['Custom appliance v2', 'other'],
  ])('classifies %s without depending on provider IDs', (label, family) =>
    expect(imageFamily(label)).toBe(family),
  );
});
