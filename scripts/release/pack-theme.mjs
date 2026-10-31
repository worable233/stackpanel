#!/usr/bin/env node
/**
 * 把仓库内主题打成**市场可安装的包**，并生成对应的目录条目。
 *
 * 主题与插件走同一条分发链（`kind: "theme"` 的目录条目 → 验签 → 原子切换
 * `data/themes/<id>`），区别只在包内布局：
 *
 *   theme.json              主题清单（id/name/version 必填，`default` 是保留 ID）
 *   theme.css               变量与样式，受 `validateThemeCss` 校验
 *   assets/**               logo / favicon 等静态资源
 *   frontend/manifest.json  有前端时（`files[]` 里列出的每个文件都必须真实存在）
 *   frontend/dist/*.js|css|map
 *   signature.json          对上面全部文件的 SHA-256 集合签名
 *
 * 与插件包的三个差别（都是内核契约决定的，不是风格选择）：
 * - 主题必须有 `theme.json` + `theme.css`（`assembleThemeFiles` 缺一个就 422）；
 * - `default` 不能上目录：内核把它当内置主题，上架同名包一律被拒；
 * - 主题**没有** `dist/`（后端代码），所以条目的 `permissions` 恒为空数组。
 *
 * 用法（仓库根执行）：
 *   pnpm release:pack-theme --out dist-pack --tag themes-v0.1.0 \
 *     --key ~/.stackpanel-release/pkg-signing.pem
 *   pnpm release:pack-theme --theme aurora --no-build ...   # 只打一个
 */
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const THEMES_ROOT = path.join(REPO_ROOT, 'packages', 'themes');
/** 内核保留 ID：`assembleThemeFiles` 直接拒绝，打在包里只会白费一次发布。 */
const RESERVED_THEME_IDS = new Set(['default']);
/** 与内核 `MAX_FRONTEND_FILE_BYTES` 对齐（`.map` 不计）。 */
const MAX_FRONTEND_FILE_BYTES = 2 * 1024 * 1024;
const ALLOWED_FRONTEND_EXTENSIONS = new Set(['.js', '.css', '.map']);
const DEFAULT_REPOSITORY = 'worable233/stackpanel-plugins';
const DEFAULT_PUBLISHER = 'stackpanel';
const encoder = new TextEncoder();
/** 固定 mtime，让同一份内容打出同一份字节（可复现构建）。 */
const FIXED_MTIME = new Date('2026-01-01T00:00:00Z');

function parseArgs() {
  const parsed = {};
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value && !value.startsWith('--')) {
      parsed[flag.slice(2)] = value;
      index += 1;
    } else {
      parsed[flag.slice(2)] = 'true';
    }
  }
  return parsed;
}

const opts = parseArgs();
const outDir = path.resolve(REPO_ROOT, opts.out ?? 'dist-pack');
const entriesDir = path.join(outDir, 'entries');
const keyPath = opts.key ? path.resolve(process.env.HOME ?? '~', opts.key.replace(/^~/, '')) : null;
const tag = opts.tag ?? 'themes-v0.1.0';
const repository = opts.repository ?? DEFAULT_REPOSITORY;
const publisher = opts.publisher ?? DEFAULT_PUBLISHER;
const channel = opts.channel ?? 'stable';
const skipBuild = opts['no-build'] === 'true' || opts.build === 'false';

if (!keyPath) {
  console.error('缺少 --key <私钥 PEM>：主题包必须与插件共用同一把发布密钥，否则目录验签不过。');
  process.exit(1);
}
if (!existsSync(keyPath)) {
  console.error(`私钥不存在：${keyPath}`);
  process.exit(1);
}

const spec = await import(pathToFileURL(path.join(REPO_ROOT, 'packages/spec/dist/index.js')).href);
const privateKeyPem = readFileSync(keyPath, 'utf8');
// 内核版本只有一处权威：`packages/spec` 的 `KERNEL_VERSION`（与插件条目同一来源）。
// 读 `packages/spec/package.json` 会拿到 spec 自己的版本（0.4.x），兼容区间整体偏
// 一整个大版本，条目发布出去就是个装不上的包。
const kernelVersion = spec.KERNEL_VERSION;
if (!kernelVersion) throw new Error('spec 未导出 KERNEL_VERSION');

function nextMinor(version) {
  const [major, minor] = version.split('.').map(Number);
  return `${major}.${minor + 1}.0`;
}

function buildFrontend(themeDir) {
  const frontendDir = path.join(themeDir, 'frontend');
  if (!existsSync(path.join(frontendDir, 'package.json'))) return;
  if (skipBuild) return;
  const pkg = JSON.parse(readFileSync(path.join(frontendDir, 'package.json'), 'utf8'));
  if (!pkg.scripts?.build) return;
  // tsup / tsc 都装在仓库根的 node_modules/.bin；插件仓曾经因为这里没进 PATH 而
  // 静默打出过期产物（exit 127 只在 stderr 里）。
  execSync('pnpm run build', {
    cwd: frontendDir,
    stdio: 'inherit',
    env: { ...process.env, PATH: `${path.join(REPO_ROOT, 'node_modules/.bin')}:${process.env.PATH ?? ''}` },
  });
}

function collectFiles(dir, prefix, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(absolute, `${prefix}${entry.name}/`, out);
      continue;
    }
    out.set(`${prefix}${entry.name}`, readFileSync(absolute));
  }
}

function collectFrontend(themeDir, files) {
  const frontendDir = path.join(themeDir, 'frontend');
  const manifestPath = path.join(frontendDir, 'manifest.json');
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const distDir = path.join(frontendDir, 'dist');
  const distNames = existsSync(distDir)
    ? readdirSync(distDir).filter((name) => {
        if (name.endsWith('.d.ts')) return false; // 内核明确拒绝声明文件
        return ALLOWED_FRONTEND_EXTENSIONS.has(path.extname(name).toLowerCase());
      })
    : [];
  if (distNames.length === 0) {
    throw new Error(`${path.basename(themeDir)} 的前端 dist 为空：先构建，或去掉 --no-build`);
  }
  // `files[]` 是内核的唯一发货白名单：按真实产物回写，而不是信任可能过期的清单。
  manifest.files = distNames.map((name) => `frontend/dist/${name}`).sort();
  if (!manifest.files.includes(manifest.entry)) {
    throw new Error(`${path.basename(themeDir)} 的 entry（${manifest.entry}）不在前端产物里`);
  }
  // 内容寻址：同一份 bundle 必须得到同一个 revision，否则每次安装都会被当成新版本。
  manifest.revision = createHash('sha256')
    .update(files.get('theme.json') ?? Buffer.alloc(0))
    .update(readFileSync(path.join(frontendDir, 'dist', path.basename(manifest.entry))))
    .digest('hex')
    .slice(0, 12);

  const shipped = [];
  for (const rel of manifest.files) {
    const absolute = path.join(themeDir, rel);
    if (!existsSync(absolute)) {
      throw new Error(`${path.basename(themeDir)} 声明的前端产物不存在：${rel}`);
    }
    const data = readFileSync(absolute);
    if (!rel.endsWith('.map') && data.byteLength > MAX_FRONTEND_FILE_BYTES) {
      throw new Error(`前端产物过大：${rel} 为 ${data.byteLength} 字节，超过内核上限`);
    }
    files.set(rel, data);
    shipped.push(rel);
  }
  files.set('frontend/manifest.json', encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`));
  shipped.push('frontend/manifest.json');
  return shipped;
}

async function packTheme(themeName) {
  const themeDir = path.join(THEMES_ROOT, themeName);
  const themeJsonPath = path.join(themeDir, 'theme.json');
  const themeCssPath = path.join(themeDir, 'theme.css');
  if (!existsSync(themeJsonPath)) throw new Error(`${themeName} 缺少 theme.json`);
  if (!existsSync(themeCssPath)) throw new Error(`${themeName} 缺少 theme.css`);
  const themeJson = JSON.parse(readFileSync(themeJsonPath, 'utf8'));
  if (themeJson.id !== themeName) {
    throw new Error(`${themeName}/theme.json 的 id 是 ${themeJson.id}：目录名与 id 必须一致`);
  }
  if (RESERVED_THEME_IDS.has(themeJson.id)) {
    throw new Error(`${themeJson.id} 是内核保留 ID，不能上目录`);
  }

  buildFrontend(themeDir);

  const files = new Map();
  files.set('theme.json', readFileSync(themeJsonPath));
  files.set('theme.css', readFileSync(themeCssPath));
  const assetsDir = path.join(themeDir, 'assets');
  if (existsSync(assetsDir)) collectFiles(assetsDir, 'assets/', files);
  const frontendFiles = collectFrontend(themeDir, files);

  const signature = spec.signPackageFiles(files, privateKeyPem);
  files.set('signature.json', encoder.encode(`${JSON.stringify(signature, null, 2)}\n`));

  mkdirSync(outDir, { recursive: true });
  const zipName = `${themeJson.id}-${themeJson.version}.zip`;
  const zipPath = path.join(outDir, zipName);
  const stage = path.join(outDir, `.stage-${themeJson.id}-${process.pid}`);
  rmSync(stage, { recursive: true, force: true });
  for (const [name, data] of files) {
    const absolute = path.join(stage, name);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, data);
    // ZIP 会把文件 mtime 写进条目：不固定它，同一份内容每次打出来的字节都不同，
    // 摘要随之变化，「这个包是不是上次那个」就无从核对。SOURCE_DATE_EPOCH 语义。
    utimesSync(absolute, FIXED_MTIME, FIXED_MTIME);
  }
  // 用内核真正跑的那段校验（`assembleThemeFiles`）过一遍再打包：清单字段、CSS
  // 危险写法、前端文件白名单、`files[]` 是否真实存在，全部在一次调用里。校验失败
  // 时 stage 目录保留，方便看现场。
  execSync(`"${path.join(REPO_ROOT, 'apps/api/node_modules/.bin/tsx')}" "${path.join(REPO_ROOT, 'scripts/release/validate-theme-package.mts')}" "${stage}"`, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      // `themes.ts` 在导入期读 `env`：给一组一次性占位值，绝不碰真实配置。
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://unused:unused@127.0.0.1:5432/unused',
      JWT_SECRET: process.env.JWT_SECRET ?? 'theme_pack_validation_secret_at_least_32_chars',
      SETTINGS_ENCRYPTION_KEY:
        process.env.SETTINGS_ENCRYPTION_KEY ?? 'theme_pack_validation_settings_key_32_chars',
    },
  });

  rmSync(zipPath, { force: true });
  // 显式按名字排序、不写目录条目（`-D`）：`zip .` 的遍历顺序随文件系统变，
  // 同一份内容会打出不同字节，摘要也就无法核对。
  const ordered = [...files.keys()].sort();
  execFileSync('zip', ['-q', '-X', '-D', zipPath, ...ordered], { cwd: stage, stdio: 'inherit' });
  rmSync(stage, { recursive: true, force: true });

  const zipBytes = readFileSync(zipPath);
  const metaPath = path.join(outDir, `.meta-${themeJson.id}.json`);
  writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        kind: 'theme',
        id: themeJson.id,
        version: themeJson.version,
        channel,
        source: { repository, tag, asset: zipName },
        compatibility: {
          kernel: `>=${kernelVersion} <${nextMinor(kernelVersion)}`,
          kernelApi: '>=0.4.0',
          frontendAbi: '^1.0.0',
          packageFormat: 1,
        },
        requires: [],
        conflicts: [],
        permissions: [],
        frontendModes: frontendFiles.length > 0 ? ['M2'] : [],
        migration: { mode: 'none', rollback: 'code-compatible' },
        automatic: { eligible: false },
        publisher,
        name: themeJson.name,
        ...(themeJson.description ? { description: themeJson.description } : {}),
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(entriesDir, { recursive: true });
  const entryPath = path.join(entriesDir, `theme-${themeJson.id}.json`);
  execSync(
    `node "${path.join(REPO_ROOT, 'scripts/release/build-manifest.mjs')}" --zip "${zipPath}" --input "${metaPath}" --out "${entryPath}"`,
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
  rmSync(metaPath, { force: true });

  console.log(
    `[pack-theme] ${themeJson.id} ${themeJson.version} → ${zipName} (${Math.round(
      statSync(zipPath).size / 1024,
    )} KB, ${files.size} files, frontend ${frontendFiles.length})`,
  );
}

const requested = opts.theme ?? 'all';
const names =
  requested === 'all'
    ? readdirSync(THEMES_ROOT, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            existsSync(path.join(THEMES_ROOT, entry.name, 'theme.json')) &&
            // `default` 随内核发布、不可卸载，上目录只会被内核拒收。
            !RESERVED_THEME_IDS.has(entry.name),
        )
        .map((entry) => entry.name)
        .sort()
    : [requested];

if (names.length === 0) {
  console.error('没有可打包的主题：packages/themes/ 下一个 theme.json 都没有');
  process.exit(1);
}

for (const name of names) await packTheme(name);
console.log(`[pack-theme] ${names.length} 个主题已产出 → ${outDir}`);
