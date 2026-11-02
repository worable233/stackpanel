import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 反代模板的**行为**回归（不是字符串断言）。
 *
 * 为什么必须真跑 nginx：这次事故的根因是路由优先级 —— `location ~ ^/(api/v1|…)`
 * 碰上面板生成的 `location ^~ /` 会**静默失效**，配置语法完全合法，`nginx -t`
 * 也通绿。只有「发一个请求、看它落到哪个上游」才能抓住。字符串断言（"文件里
 * 应该有 ^~"）会放过「写法对但被更长的前缀抢先」这类错误。
 *
 * 三件事一起锁住：
 *   1. 每种拓扑生成的配置都能被 `nginx -t` 接受；
 *   2. 在**面板形态**（`location ^~ /` 兜底）下，每个 API 前缀仍然命中 API；
 *   3. 生成的配置里**没有任何正则 location** —— 一旦有人改回 `~`，这里立刻红。
 */

// 测试文件在 apps/web/tests/，仓库根在上三级。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = path.join(repoRoot, 'scripts', 'proxy-config.mjs');
const template = path.join(repoRoot, 'docker', 'proxy', 'nginx.conf.example');
const common = path.join(repoRoot, 'docker', 'proxy', 'sp-common.conf');

function generate(args: string[]): string {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

/** `docker` 可用吗？CI 里有，本地可能没有 —— 没有就跳过行为断言而不是假绿。 */
const dockerAvailable =
  spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 }).status === 0;

const TOPOLOGIES: Array<[string, string[]]> = [
  ['same-host', []],
  // container 拓扑的上游是服务名，解析不了会 `host not found in upstream`；
  // 用宿主地址生成，语义不变（真实部署里由 --web-upstream 指定）。
  ['container', ['--web-upstream', '172.18.0.1:3000', '--api-upstream', '172.18.0.1:3001']],
  ['cdn', ['--cdn', 'cloudflare']],
  ['passthrough', []],
];

describe('反代模板（docker/proxy）', () => {
  it('模板与共享片段都没有正则 location', () => {
    for (const file of [template, common]) {
      const source = readFileSync(file, 'utf8');
      const code = source
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');
      // `location ~` / `location ~*` 都会被面板的 `^~ /` 静默吞掉。
      expect(code, `${path.basename(file)} 里出现了正则 location`).not.toMatch(
        /location\s+~\*?\s/,
      );
    }
  });

  it('每个 API 前缀都显式声明为 ^~，且内核的 /api/v1/ 与 BFF 的 /api/ 不混淆', () => {
    const code = readFileSync(common, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

    // 内核：所有路由都在 /api/v1/ 下
    expect(code).toMatch(/location\s+\^~\s+\/api\/v1\/\s*\{\s*__SP_PROXY_API__\s*\}/);

    // BFF：这些 `/api/` 子前缀必须走 Web
    for (const prefix of [
      '/api/account/avatar',
      '/api/action-flash',
      '/api/admin/notifications',
      '/api/agent/',
      '/api/frontend-abi/',
      '/api/notifications',
      '/api/plugins/',
      '/api/store/',
    ]) {
      const escaped = prefix.replace(/[/.]/g, '\\$&');
      expect(code, `${prefix} 没有声明为 Web`).toMatch(
        new RegExp(`location\\s+\\^~\\s+${escaped}\\s*\\{\\s*__SP_PROXY_WEB__\\s*\\}`),
      );
    }

    // API 的非 /api/ 前缀（少一个就某类资源 404）
    for (const prefix of [
      '/mcp',
      '/sp/',
      '/llm-gateway/',
      '/callbacks/',
      '/zjmf_api_login',
      '/cart/',
      '/host/',
      '/provision/',
      '/themes/',
      '/plugins/',
      '/media/',
      '/platform/',
      '/health',
      '/ready',
      '/version',
    ]) {
      const escaped = prefix.replace(/[/.]/g, '\\$&');
      expect(code, `${prefix} 没有转发到 API`).toMatch(
        new RegExp(`location\\s+\\^~\\s+${escaped}\\s*\\{\\s*__SP_PROXY_API__\\s*\\}`),
      );
    }
  });

  it.each(TOPOLOGIES)('%s 拓扑生成后没有未替换的占位符', (name, extra) => {
    const output = generate(['--topology', name, ...extra, '--domain', 'sp.example.com']);
    const code = output
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(code).not.toContain('__SP_');
    // 协议头不能用 $scheme 直接顶替（cdn 拓扑必须写死 https）
    if (name === 'cdn') {
      expect(output).toMatch(/''\s+https;/);
    }
  });

  it('cdn 拓扑会把官方回源段展开进 set_real_ip_from', () => {
    const output = generate(['--topology', 'cdn', '--cdn', 'cloudflare', '--domain', 'x.test']);
    expect(output).toMatch(/set_real_ip_from 173\.245\.48\.0\/20/);
    expect(output).toMatch(/real_ip_header X-Forwarded-For;/);
    expect(output).toMatch(/real_ip_recursive on;/);
  });

  it('未知拓扑给出可执行的错误，而不是静默生成一份错配置', () => {
    const result = spawnSync(process.execPath, [script, '--topology', 'nope'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('未知拓扑');
    expect(result.stderr).toContain('same-host');
  });
});

describe.skipIf(!dockerAvailable)('反代模板：真跑 nginx 验证路由', () => {
  /**
   * 起三个 nginx：web / api 各回显自己收到的路径，前面一个「面板形态」的 nginx
   * 带 `location ^~ /` 兜底。然后逐条请求，断言落到哪个上游。
   */
  const runId = `sp-proxy-${process.pid}-${Date.now().toString(36)}`;
  const net = `${runId}-net`;

  /**
   * 取一个**空闲**宿主机端口。
   *
   * 不能用固定端口：开发者机器上常年跑着别的实例（我自己的冒烟栈就占着
   * 18000/18001），固定端口会让测试因为「端口被占」失败 —— 一个与配置正确性
   * 无关的原因。绑 0 让内核挑，拿完立刻释放，再交给 nginx 绑。
   */
  function freePort() {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close(() => (port ? resolve(port) : reject(new Error('拿不到空闲端口'))));
      });
    });
  }

  function sh(cmd: string, args: string[], options: Record<string, unknown> = {}) {
    return execFileSync(cmd, args, { encoding: 'utf8', ...options }).trim();
  }

  it(
    '在面板的 ^~ / 之下，16 个 API 前缀仍然命中 API',
    async () => {
      const edgePort = await freePort();
      // **不要用 os.tmpdir()**：macOS 的 /var/folders/... 不会被 Docker Desktop /
      // colima 的虚拟机共享，挂进容器是空目录，症状是 `cp: can't stat '/c/edge.conf'`。
      // 家目录一定是共享的。
      const dir = mkdtempSync(path.join(homedir(), '.sp-proxy-'));
      const containers = ['web', 'api', 'edge'].map((name) => `${runId}-${name}`);
      const cleanup = () => {
        for (const name of containers) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
        spawnSync('docker', ['network', 'rm', net], { stdio: 'ignore' });
        rmSync(dir, { recursive: true, force: true });
      };

      try {
        for (const name of ['web', 'api']) {
          mkdirSync(path.join(dir, name), { recursive: true });
          writeFileSync(
            path.join(dir, name, 'site.conf'),
            `server {\n  listen 80;\n  location / { return 200 "${name.toUpperCase()}:$uri\\n"; }\n}\n`,
          );
        }

        // 用生成器产出的配置，套一个「面板形态」的 server：面板自己生成的
        // `location ^~ /` 作为兜底。这正是 1Panel / 宝塔的形态 —— 旧模板（正则
        // location）在这种配置下会**整片失效**，而这正是本用例要锁住的行为。
        //
        // 做法：把生成结果里 `server {` 之前的 http 级指令（map / upstream /
        // set_real_ip_from）原样保留，`server { ... }` 内部则取出逐个 location，
        // 拼进新的 server 块。不写 YAML/nginx 解析器 —— 逐行搬，错了 nginx -t 会报。
        const generated = generate(['--topology', 'container', '--domain', '_']);
        const lines = generated.split('\n');
        const serverStart = lines.findIndex((line) => /^server\s*\{/.test(line));
        expect(serverStart, '生成结果里没有 server 块').toBeGreaterThan(0);
        // 生成结果里的上游是 `stackpanel-web:3000` 这类名字；测试里两个上游容器的
        // 别名是 `web` / `api`，端口 80。只替换 `upstream { server …; }` 内部那一行。
        // 生成结果里的 upstream 指向 `stackpanel-web:3000` 之类的服务名；测试里两个
        // 上游容器的网络别名是 `web` / `api`、端口 80。只改 upstream 的 server 行，
        // 其余（包括 `upstream stackpanel_web` 这个名字本身）保持原样 ——
        // location 里引用的就是这个名字，改名会连带断掉。
        let currentUpstream: string | null = null;
        const httpLevel = lines.slice(0, serverStart).map((line) => {
          const opens = /^\s*upstream\s+(\S+)\s*\{/.exec(line);
          if (opens) {
            currentUpstream = opens[1] ?? null;
            return line;
          }
          if (currentUpstream && /^\s*\}\s*$/.test(line)) {
            currentUpstream = null;
            return line;
          }
          if (currentUpstream && /^\s*server\s+\S+;/.test(line)) {
            return currentUpstream === 'stackpanel_web' ? '    server web:80;' : '    server api:80;';
          }
          return line;
        });
        // 取 server{} 内**除 listen / server_name / 两个超时设置之外**的全部内容
        // （location 块与它们之间的注释）。多个 location 都必须完整拷贝：只取
        // `location …` 那一行会截断块体，nginx 会报 `location "…" is outside
        // location "…"`。
        const serverBody = lines
          .slice(serverStart + 1)
          .filter((line) => !/^\s*listen\s/.test(line))
          .filter((line) => !/^\s*server_name\s/.test(line))
          .filter((line) => !/^\s*client_max_body_size\s/.test(line))
          .filter((line) => !/^\s*proxy_send_timeout\s/.test(line))
          .filter((line) => !/^\}\s*$/.test(line));
        // 模板自带的兜底 `location /` 与下面「面板自己生成的兜底」重复，会报
        // `duplicate location "/"` —— 测试场景里由面板那条代替它。
        const templateFallback = serverBody.findIndex((line) => /^\s*location \/ \{/.test(line));
        if (templateFallback !== -1) {
          // 连带它后面的块体一起删掉（直到与它同缩进的 `}`）。
          const indent = /^\s*/.exec(serverBody[templateFallback] ?? '')?.[0] ?? '';
          let endIndex = templateFallback + 1;
          while (endIndex < serverBody.length && serverBody[endIndex] !== `${indent}}`) {
            endIndex += 1;
          }
          serverBody.splice(templateFallback, endIndex - templateFallback + 1);
        }
        expect(
          serverBody.filter((line) => /^\s*location\s/.test(line)).length,
          '生成结果里没有 location 行',
        ).toBeGreaterThan(20);

        writeFileSync(
          path.join(dir, 'edge.conf'),
          [
            'events { worker_connections 128; }',
            'http {',
            ...httpLevel.map((line) => `  ${line}`),
            '  server {',
            '    listen 18080;',
            '    server_name _;',
            ...serverBody.map((line) => `  ${line}`),
            // 面板自己生成的兜底
            '    location ^~ / { proxy_pass http://stackpanel_web; proxy_set_header Host $host; }',
            '  }',
            '}',
            '',
          ].join('\n'),
        );

        sh('docker', ['network', 'create', net]);
        for (const name of ['web', 'api']) {
          sh('docker', [
            'run', '-d', '--name', `${runId}-${name}`, '--network', net,
            '--network-alias', name,
            '-v', `${path.join(dir, name)}:/etc/nginx/conf.d/:ro`,
            'nginx:alpine', 'sh', '-c',
            'rm -f /etc/nginx/conf.d/default.conf; nginx -g "daemon off;"',
          ]);
        }
        sh('docker', [
          'run', '-d', '--name', `${runId}-edge`, '--network', net, '-p', `${edgePort}:18080`,
          '-v', `${dir}:/c:ro`, 'nginx:alpine', 'sh', '-c',
          'cp /c/edge.conf /etc/nginx/nginx.conf; nginx -g "daemon off;"',
        ]);

        // 等 edge 起来（最多 20s）。探测**不解析 HTTP 状态码**：`curl -o /dev/null
        // -w '%{http_code}'` 的输出在不同 curl 版本上不一致，会把「已就绪」误判成
        // 「未就绪」。直接看响应体首行更可靠。
        const deadline = Date.now() + 20_000;
        let ready = false;
        let lastProbe = '';
        while (Date.now() < deadline) {
          const probe = spawnSync(
            'curl',
            ['-s', '--max-time', '2', `http://127.0.0.1:${edgePort}/`],
            { encoding: 'utf8' },
          );
          lastProbe = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim();
          if (lastProbe.startsWith('WEB:/')) {
            ready = true;
            break;
          }
          execFileSync('sleep', ['0.5']);
        }
        if (!ready) {
          // 起不来时把生成的配置与容器日志一起带出来 —— 否则只能看到一个
          // 「未就绪」，还得手工重跑一遍才能知道是语法错还是路由错。
          const logs = spawnSync('docker', ['logs', `${runId}-edge`], { encoding: 'utf8' });
          const ps = spawnSync('docker', ['ps', '-a', '--filter', `name=${runId}`, '--format', '{{.Names}} {{.Status}}'], { encoding: 'utf8' });
          const conf = readFileSync(path.join(dir, 'edge.conf'), 'utf8');
          throw new Error(
            `edge nginx 未就绪（最后探测：${JSON.stringify(lastProbe)}）：\n` +
              `${logs.stdout}${logs.stderr}\n--- ps ---\n${ps.stdout}\n--- edge.conf ---\n${conf}`,
          );
        }

        const fetchPath = (p: string): string =>
          sh('curl', ['-s', `http://127.0.0.1:${edgePort}${p}`]).split('\n')[0];

        // API 前缀：必须落到 api 上游，且路径**原样保留**
        for (const p of [
          '/api/v1/platform',
          '/api/v1/me',
          '/themes/default/theme.css',
          '/plugins/market/admin.js',
          '/media/avatars/a.png',
          '/mcp',
          '/llm-gateway/v1/chat/completions',
          '/callbacks/alipay',
          '/health',
          '/ready',
          '/version',
        ]) {
          expect(fetchPath(p), `${p} 没有命中 API 上游`).toBe(`API:${p}`);
        }

        // Web 前缀：BFF 与页面兜底
        for (const p of [
          '/',
          '/account/settings',
          '/api/action-flash?token=x',
          '/api/notifications/unread-count',
          '/api/agent/status',
          '/api/plugins/market/admin',
          '/api/store/upstream-products',
          '/api/frontend-abi/x',
        ]) {
          expect(fetchPath(p), `${p} 没有命中 Web 上游`).toBe(`WEB:${p.split('?')[0]}`);
        }
      } finally {
        cleanup();
      }
    },
    180_000,
  );
});
