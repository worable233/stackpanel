#!/usr/bin/env node
/**
 * 智简魔方（ZJMF）V10 真实上游探针 / 契约取证。
 *
 * 用途：把「未取证」变成「已取证」。对着一个真实 V10 实例跑一遍，产出：
 *   1. 每个候选路由的真实 HTTP 状态、上游 status/msg、data 结构（脱敏后）；
 *   2. 一份 JSON 报告，供后续把 zjmf-upstream 的路径/字段映射钉到真实契约上；
 *   3. 明确区分「确实不存在（404/路由未定义）」与「存在但鉴权/参数失败」。
 *
 * 只读：默认不触发任何开关机/重装/删除。VNC 只取控制台地址（不落盘明文密码）。
 *
 * 用法：
 *   ZJMF_BASE_URL=https://upstream.example.com \
 *   ZJMF_USERNAME=client@example.com \
 *   ZJMF_PASSWORD='<后台 API 信息里的 token>' \
 *   node scripts/probe-zjmf-v10.mjs
 *
 * 可选：
 *   ZJMF_PRODUCT_ID=12        指定商品做详情/资源探测
 *   ZJMF_SERVICE_ID=34        指定已购实例做实例路由探测
 *   ZJMF_DOWNSTREAM_CLIENT_ID=7  代理模式（remf_cloud）下传下游用户 ID
 *   ZJMF_FAMILY=mf_cloud|remf_cloud|mf_dcim|idcsmart_common   只探某一个家族
 *   ZJMF_OUT=./v10-probe.json 报告输出路径（默认 ./zjmf-v10-probe.json）
 *   ZJMF_TIMEOUT_MS=20000     单请求超时
 *   ZJMF_ALLOW_WRITE=1        允许写入类探测（开关机/重装等，危险，默认关闭）
 *
 * 退出码：0 = 鉴权成功且至少一条实例/商品路由成功；1 = 鉴权失败；2 = 用法/网络错误。
 */

import { writeFile } from 'node:fs/promises';

const BASE = (process.env.ZJMF_BASE_URL ?? '').replace(/\/+$/, '');
const USERNAME = process.env.ZJMF_USERNAME ?? '';
const PASSWORD = process.env.ZJMF_PASSWORD ?? '';
const PRODUCT_ID = process.env.ZJMF_PRODUCT_ID ?? '';
const SERVICE_ID = process.env.ZJMF_SERVICE_ID ?? '';
const DOWNSTREAM_CLIENT_ID = process.env.ZJMF_DOWNSTREAM_CLIENT_ID ?? '';
const FAMILY_FILTER = process.env.ZJMF_FAMILY ?? '';
const OUT = process.env.ZJMF_OUT ?? './zjmf-v10-probe.json';
const TIMEOUT = Number(process.env.ZJMF_TIMEOUT_MS ?? 20_000);
const ALLOW_WRITE = process.env.ZJMF_ALLOW_WRITE === '1';

if (!BASE || !USERNAME || !PASSWORD) {
  console.error(
    '缺少环境变量：ZJMF_BASE_URL / ZJMF_USERNAME / ZJMF_PASSWORD（password 填后台「API 信息」里的 token，不是账号密码）',
  );
  process.exit(2);
}

/** 敏感字段：报告里一律替换为 `<redacted>`。 */
const SECRET_KEYS = new Set([
  'jwt',
  'token',
  'password',
  'pass',
  'vnc_pass',
  'new_password',
  'secret',
  'api_key',
  'authorization',
]);

let jwt = '';

function describe(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'array(0)';
    return `array(${value.length}) of ${describe(value[0], Math.min(depth + 1, 4))}`;
  }
  if (typeof value === 'object') {
    if (depth >= 4) return 'object';
    const keys = Object.keys(value);
    if (keys.length === 0) return 'object{}';
    return `{ ${keys.map((key) => `${key}: ${describe(value[key], depth + 1)}`).join(', ')} }`;
  }
  return typeof value;
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEYS.has(key.toLowerCase()) ? '<redacted>' : redact(inner);
    }
    return out;
  }
  return value;
}

function form(body) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    params.append(key, String(value));
  }
  return params.toString();
}

async function call(method, path, body) {
  const url = `${BASE}/${path.replace(/^\/+/, '')}`;
  const headers = { Accept: 'application/json' };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  let payload;
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = form(body);
  }
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: payload,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return {
      method,
      path,
      httpStatus: response.status,
      ms: Date.now() - started,
      upstreamStatus: json?.status ?? null,
      msg: json?.msg ?? json?.message ?? null,
      shape: json ? describe(redact(json)) : `<non-json ${text.slice(0, 120)}>`,
      sample: json ? redact(json) : null,
      rawPrefix: json ? null : text.slice(0, 400),
    };
  } catch (error) {
    return {
      method,
      path,
      httpStatus: null,
      ms: Date.now() - started,
      error: String(error?.message ?? error),
    };
  }
}

function verdict(result) {
  if (result.httpStatus === null) return 'NETWORK';
  if (result.httpStatus === 404) return 'MISSING';
  if (result.httpStatus === 405) return 'METHOD';
  if (result.httpStatus === 401 || result.httpStatus === 403) return 'AUTH';
  if (result.upstreamStatus === 200) return 'OK';
  if (result.upstreamStatus === 400) return 'BAD_PARAM';
  if (result.httpStatus === 200) return 'OK_NO_STATUS';
  return 'HTTP_' + result.httpStatus;
}

const results = [];
async function probe(label, method, path, body) {
  const result = await call(method, path, body);
  const row = { label, ...result, verdict: verdict(result) };
  results.push(row);
  const tag = row.verdict.padEnd(12);
  console.log(
    `${tag} ${String(row.httpStatus ?? '-').padStart(3)} ${method.padEnd(6)} ${path}${row.msg ? `  → ${row.msg}` : ''}`,
  );
  return row;
}

/* ------------------------------- 1. 鉴权 ------------------------------- */

console.log(`\n[1/4] 鉴权  POST /api/v1/auth  (username=${USERNAME})\n`);
const auth = await call('POST', 'api/v1/auth', { username: USERNAME, password: PASSWORD });
if (auth.httpStatus !== 200 || auth.upstreamStatus !== 200) {
  console.error(
    `鉴权失败：http=${auth.httpStatus} status=${auth.upstreamStatus} msg=${auth.msg ?? auth.error ?? auth.rawPrefix}`,
  );
  await writeFile(
    OUT,
    JSON.stringify({ base: BASE, username: USERNAME, auth: { ...auth, sample: null } }, null, 2),
  );
  console.error(`\n报告已写入 ${OUT}`);
  process.exit(1);
}
jwt = auth.sample?.data?.jwt ?? '';
const authVerdict = jwt ? 'OK' : 'OK_NO_JWT';
results.push({
  label: 'auth',
  ...auth,
  sample: { ...auth.sample, data: { jwt: jwt ? '<redacted>' : null } },
  verdict: authVerdict,
});
if (!jwt) {
  console.error('鉴权返回 200 但没有 data.jwt，无法继续。');
  process.exit(1);
}
console.log(`OK          200 POST   api/v1/auth  → 已取得 JWT\n`);

/* ----------------------------- 2. 商品开放 API ----------------------------- */

console.log('[2/4] 商品开放 API（route/api.php，已取证）\n');
await probe('product.list', 'GET', 'api/v1/product');
await probe('product.group', 'GET', 'api/v1/group/product');
if (PRODUCT_ID) {
  await probe('product.detail', 'GET', `api/v1/product/${encodeURIComponent(PRODUCT_ID)}`);
  await probe(
    'product.resource',
    'GET',
    `api/v1/product/${encodeURIComponent(PRODUCT_ID)}/resource`,
  );
}

/* --------------------------- 3. 服务生命周期路由家族 --------------------------- */

console.log('\n[3/4] 服务生命周期：console/v1 家族（按上游实际装的模块探测）\n');

// 通用（与模块无关）的下游对接面：ZJMF 自己的代理实现 ResModuleLogic 就走这套。
console.log('  通用下游面：console/v1/host*、cart/settle、pay\n');
await probe('host.list', 'GET', 'console/v1/host?page=1&limit=20');

const families = [
  { name: 'mf_cloud', base: 'console/v1/mf_cloud', list: 'console/v1/mf_cloud' },
  { name: 'remf_cloud', base: 'console/v1/remf_cloud', list: 'console/v1/remf_cloud' },
  { name: 'mf_dcim', base: 'console/v1/mf_dcim', list: 'console/v1/mf_dcim' },
  { name: 'idcsmart_common', base: 'console/v1/idcsmart_common', list: 'console/v1/idcsmart_common/host' },
].filter((family) => !FAMILY_FILTER || family.name === FAMILY_FILTER);

const downstream = DOWNSTREAM_CLIENT_ID ? { downstream_client_id: DOWNSTREAM_CLIENT_ID } : {};

let listHit = null;
for (const family of families) {
  const row = await probe(`${family.name}.list`, 'GET', `${family.list}?page=1&limit=20`);
  if (row.verdict === 'OK' && row.sample?.data?.list) {
    listHit = {
      family,
      firstId: String(row.sample.data.list[0]?.id ?? '') || null,
      count: row.sample.data.list.length,
    };
  }
}

const serviceId = SERVICE_ID || listHit?.firstId || '';
let activeFamily = listHit?.family;
if (serviceId && !activeFamily) {
  // 只给了实例 ID 但列表为空：用各家族详情路由反查该实例属于哪个模块。
  for (const family of families) {
    const row = await probe(
      `${family.name}.detail(probe)`,
      'GET',
      `${family.base}/${encodeURIComponent(serviceId)}`,
    );
    if (row.verdict === 'OK') {
      activeFamily = family;
      break;
    }
  }
}

if (serviceId && activeFamily) {
  const base = activeFamily.base;
  console.log(
    `\n  实例探测：${activeFamily.name} id=${serviceId}${SERVICE_ID ? '（来自 ZJMF_SERVICE_ID）' : '（取自列表首条）'}\n`,
  );
  const id = encodeURIComponent(serviceId);
  // 各家族的详情面/子资源面不一致（见 zjmf-client.ts 的 v10ActionPath 注释），
  // 探针也按家族只打「该家族源码里真实存在」的路径，避免把 404 误读成缺失能力。
  const isCommon = activeFamily.name === 'idcsmart_common';
  const isDcim = activeFamily.name === 'mf_dcim';
  const readOnly = [
    ['host.detail', `console/v1/host/${id}`],
    ['host.ip', `console/v1/host/${id}/ip`],
    ...(isCommon
      ? [['detail(configoption)', `${base}/host/${id}/configoption`]]
      : [
          ['detail', `${base}/${id}`],
          ['part', `${base}/${id}/part`],
          ['status', `${base}/${id}/status`],
          ['remote_info', `${base}/${id}/remote_info`],
          ...(isDcim
            ? []
            : [
                ['disk', `${base}/${id}/disk`],
                ['snapshot', `${base}/${id}/snapshot`],
                ['backup', `${base}/${id}/backup`],
              ]),
        ]),
    ['ip', `${base}/${id}/ip`],
    ['log', `${base}/${id}/log`],
  ];
  for (const [label, path] of readOnly) {
    await probe(label, 'GET', path);
  }
  // 图表：云/物理机是 GET ?type=，通用产品是 POST configoption/chart（对象数组）。
  if (isCommon) {
    for (const type of ['cpu', 'memory', 'flow']) {
      await probe(`chart.${type}`, 'POST', `${base}/host/${id}/configoption/chart`, {
        chart: [{ type, start: Math.floor(Date.now() / 1000) - 3600 }],
      });
    }
  } else {
    for (const type of ['cpu', 'memory', 'bw']) {
      await probe(`chart.${type}`, 'GET', `${base}/${id}/chart?type=${type}`);
    }
  }
  // 续费试算（GET）不下单；实际续费（POST）属写操作。
  await probe('host.renew_quote', 'GET', `console/v1/host/${id}/renew`);
  if (ALLOW_WRITE) {
    await probe('host.renew', 'POST', `console/v1/host/${id}/renew`, {
      billing_cycle: 'monthly',
      ...downstream,
    });
  }
  // VNC 只取地址/临时令牌，属于只读；仍与写操作分开，便于报告里区分。
  // 通用产品（idcsmart_common）没有 VNC 动作，源码里不存在该路由。
  const vnc = isCommon
    ? { verdict: 'SKIP', sample: null }
    : await probe('vnc', 'POST', `${base}/${id}/vnc`, {
        more: '1',
        ...downstream,
      });
  if (vnc.sample?.data) {
    const data = vnc.sample.data;
    console.log(
      `  ↳ VNC 字段：${Object.keys(data).join(', ')}${data.vnc_url ? '（含 vnc_url）' : ''}${data.url ? '（含 url）' : ''}`,
    );
  }
  // 升降级/子资源价格（只算价，不下单）。
  if (activeFamily.name === 'mf_cloud' || activeFamily.name === 'remf_cloud') {
    await probe('recommend_config', 'GET', `${base}/${id}/recommend_config`);
    await probe('common_config', 'GET', `${base}/${id}/common_config`, downstream);
    await probe('real_data', 'GET', `${base}/${id}/real_data`);
  }

  if (ALLOW_WRITE) {
    console.log('\n  ⚠ ZJMF_ALLOW_WRITE=1：执行开关机探测（会真实影响实例）\n');
    const powerPaths = isCommon
      ? [
          ['power_on', `${base}/host/${id}/provision/on`],
          ['power_off', `${base}/host/${id}/provision/off`],
          ['reboot', `${base}/host/${id}/provision/reboot`],
        ]
      : [
          ['power_on', `${base}/${id}/on`],
          ['power_off', `${base}/${id}/off`],
          ['reboot', `${base}/${id}/reboot`],
        ];
    for (const [label, path] of powerPaths) {
      await probe(label, 'POST', path, downstream);
    }
  } else {
    console.log('\n  （跳过开关机/重装：设置 ZJMF_ALLOW_WRITE=1 才会执行）');
  }
} else {
  console.log('\n  未发现可探测实例（列表为空或未给 ZJMF_SERVICE_ID），跳过实例路由。');
}

/* --------------------------- 4. 反证：虚构路由确实不存在 --------------------------- */

console.log('\n[4/4] 反证：旧实现的 /api/v1/service* 是否真的不存在\n');
const id = SERVICE_ID ? encodeURIComponent(SERVICE_ID) : '1';
await probe('legacy.service_list', 'GET', 'api/v1/service');
await probe('legacy.service_detail', 'GET', `api/v1/service/${id}`);
await probe('legacy.service_action', 'POST', `api/v1/service/${id}/action`, { action: 'on' });

/* --------------------------------- 汇总 --------------------------------- */

const summary = results.reduce((acc, row) => {
  acc[row.verdict] = (acc[row.verdict] ?? 0) + 1;
  return acc;
}, {});

const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  username: USERNAME,
  version: process.env.ZJMF_VERSION ?? null,
  family: activeFamily?.name ?? null,
  serviceId: serviceId || null,
  productId: PRODUCT_ID || null,
  summary,
  results,
};
await writeFile(OUT, JSON.stringify(report, null, 2));

console.log('\n— 汇总 —');
for (const [key, value] of Object.entries(summary)) console.log(`  ${key}: ${value}`);
const ok = results.some(
  (row) => row.verdict === 'OK' && !row.label.startsWith('legacy.'),
);
console.log(`\n报告：${OUT}`);
console.log(
  ok
    ? '结论：鉴权 + 至少一条真实业务路由成功，可以把该实例的字段结构固化为 fixtures。'
    : '结论：鉴权成功但没有业务路由返回 200，请把报告发回以定位模块/权限问题。',
);
process.exit(ok ? 0 : 2);
