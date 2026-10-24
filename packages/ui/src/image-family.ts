/** Match provider labels without changing their IDs; unknown images stay selectable. */
export function imageFamily(label: string): string {
  const value = label.toLowerCase().replace(/[\s_.-]+/g, '');
  const families: Array<[string, RegExp]> = [
    ['windows', /windows|winserver|win(?:2008|2012|2016|2019|2022|2025|10|11)/],
    ['almalinux', /almalinux|alma/],
    ['rocky', /rockylinux|rocky/],
    ['opensuse', /opensuse|suse/],
    ['freebsd', /freebsd/],
    ['debian', /debian/],
    ['ubuntu', /ubuntu/],
    ['centos', /centos/],
    ['fedora', /fedora/],
    ['rhel', /redhat|rhel/],
    ['alpine', /alpine/],
    ['oracle', /oraclelinux/],
    ['arch', /archlinux/],
  ];
  return families.find(([, pattern]) => pattern.test(value))?.[0] ?? 'other';
}
