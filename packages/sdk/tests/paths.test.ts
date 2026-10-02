import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  findRepoRoot,
  resolveStackPanelDataDir,
  resolveStackPanelDatabaseUrl,
} from '../src/paths.js';

const repoRoot = path.resolve(__dirname, '../../..');

describe('findRepoRoot', () => {
  it('discovers the monorepo root from a nested directory', () => {
    const root = findRepoRoot(path.join(repoRoot, 'apps', 'api', 'src', 'lib'));
    expect(root).toBe(repoRoot);
  });

  it('returns null above the filesystem root', () => {
    expect(findRepoRoot('/')).toBeNull();
  });
});

describe('resolveStackPanelDataDir', () => {
  it('honors an explicit STACKPANEL_DATA_DIR override', () => {
    const resolved = resolveStackPanelDataDir({
      env: { STACKPANEL_DATA_DIR: '/srv/stackpanel/data' },
      cwd: '/unrelated',
    });
    expect(resolved).toBe('/srv/stackpanel/data');
  });

  it('falls back to <repo-root>/data when the env var is unset', () => {
    const resolved = resolveStackPanelDataDir({ env: {}, moduleUrl: __filename });
    expect(resolved).toBe(path.join(repoRoot, 'data'));
  });

  it('treats an empty env var as unset', () => {
    const resolved = resolveStackPanelDataDir({
      env: { STACKPANEL_DATA_DIR: '  ' },
      moduleUrl: __filename,
    });
    expect(resolved).toBe(path.join(repoRoot, 'data'));
  });
});

describe('resolveStackPanelDatabaseUrl', () => {
  const dataDir = '/srv/stackpanel/data';

  it('anchors a relative file: path to the data directory', () => {
    expect(resolveStackPanelDatabaseUrl('file:./stackpanel.db', dataDir)).toBe(
      `file:${path.join(dataDir, 'stackpanel.db')}`,
    );
  });

  it('leaves an absolute file: path unchanged', () => {
    expect(resolveStackPanelDatabaseUrl('file:/tmp/stackpanel.db', dataDir)).toBe(
      'file:/tmp/stackpanel.db',
    );
  });

  it('leaves non-file DSNs unchanged', () => {
    expect(resolveStackPanelDatabaseUrl('mysql://u:p@host/db', dataDir)).toBe(
      'mysql://u:p@host/db',
    );
  });
});
