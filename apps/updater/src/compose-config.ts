import { accessSync, constants } from 'node:fs';
import path from 'node:path';

/**
 * 绑定部署配置（PLAN-github-distribution-and-updates §5.1、§5.4）。
 *
 * updater 只操作**安装时绑定的 Compose project**、允许的服务与受管卷；不执行包内
 * 任意 compose/shell hook。本模块把这份绑定关系变成可校验的配置：project 目录、
 * compose 文件、服务名映射、镜像注入变量、数据库连接与探针地址。任何不在
 * `allowedServices` 内的服务都不参与切换。
 */

export interface ComposeServiceNames {
  api: string;
  worker: string;
  web: string;
  /**
   * 一次性迁移服务（`restart: "no"` + `entrypoint-migrate`，ADR-0025）。
   *
   * 必须用它而不是 `run api <cmd>`：api 服务的 entrypoint 是
   * `entrypoint-api.sh`，它**忽略** `$@` 并 `exec node apps/api/dist/server.js`，
   * 于是 `run api pnpm ... migrate:deploy` 实际启动的是第二个 API 进程，
   * 迁移永不执行、命令一直挂到超时。
   */
  migrate: string;
}

export interface DatabaseConfig {
  /** compose 服务名（在其容器内执行 pg_dump/pg_restore/psql）。直连模式下不用。 */
  service: string;
  user: string;
  name: string;
  /** 可选：数据库所属卷/挂载，用于磁盘空间估算。 */
  volume?: string;
  /**
   * 直连模式的连接信息（P0-B）。
   *
   * 默认模式是「在 compose 里的 db 容器内执行 pg_dump」，假设数据库
   * 属于本 project。但自托管部署很常见（如 1Panel 托管 PostgreSQL，容器
   * 在另一个 network）：直接指向它会报 `no such service`，快照必然失败。
   * 那种情况下只能加一个 pg 客户端跳板容器జ 而 updater 镜像**本就自带**
   * `postgresql-client`，完全可以直接在自己进程里跑 pg_dump。
   */
  connection?: DatabaseConnection;
}

/** 直连数据库的连接参数（`UPDATER_DB_HOST` 启用）。 */
export interface DatabaseConnection {
  host: string;
  port: number;
  user: string;
  /** 密码可缺省（信任认证 / .pgpass）。 */
  password?: string;
  name: string;
}

export interface ProbeConfig {
  /** 维护态依赖就绪探针 URL（如 `http://api:3001/health`）。 */
  readinessUrl: string;
  /** 业务登录/权限探针 URL；缺省跳过。 */
  loginProbeUrl?: string;
  /** 目标 Web 资源探针 URL；缺省跳过。 */
  webUrl?: string;
  /**
   * 等待探针转绿的总预算（毫秒）。**不是**单次请求超时。
   *
   * 为什么必需：切换后 `up -d` 只保证容器被创建，API 还要跑启动自检、连库、
   * 注册插件，冷启动常见 10–60 秒（装了插件或跑迁移后更久）。用一次 5 秒探针
   * 判生死，会把**正常升级**系统性误判为失败并自动回退——真机演练里就出现了
   * 「回退后探针仍未通过，保持维护」，实例被留在维护态。
   */
  readyTimeoutMs?: number;
  /** 轮询间隔（毫秒）；缺省 2000。 */
  readyPollIntervalMs?: number;
  /** Worker 心跳检查命令（在 worker 容器内执行）；缺省用 compose ps 状态。 */
  workerHeartbeatCommand?: string[];
}

export interface ComposeProjectConfig {
  /** 绑定的 Compose project 名（`docker compose -p`）。 */
  projectName: string;
  /** project 目录（命令工作目录）。 */
  projectDir: string;
  /** compose 文件路径（相对 projectDir 或绝对路径）。 */
  composeFiles: string[];
  /**
   * compose 变量文件（`--env-file`），相对 projectDir 或绝对路径。
   *
   * 为什么必需：`docker/.env` 里是 POSTGRES_PASSWORD / JWT_SECRET / MINIO_ROOT_PASSWORD
   * 等**生成于安装时**的密钥。updater 在容器里执行 `docker compose`，
   * 它的进程环境**不含**这些变量；不显式传 `--env-file` 时 compose 会把
   * `${POSTGRES_PASSWORD}` 等插值成空串，于是 `up -d` 会用空密码重建
   * postgres / api——一次「成功」的升级会把数据库锁死。
   */
  envFile?: string;
  services: ComposeServiceNames;
  /**
   * 承载内核镜像引用的环境变量名（如 `STACKPANEL_IMAGE`）。切换时把它指向目标
   * digest 并重新 `up -d`，从而让 api/worker/web 落到**同一 release 集合**。
   */
  imageEnv: string;
  /**
   * 除 `imageEnv` 外还需要同步的镜像变量名（如 `STACKPANEL_WEB_IMAGE`）。
   *
   * web 与 api 曾经用**不同**变量指向镜像。updater 只覆盖
   * `STACKPANEL_IMAGE`，于是升级后能出现「api/worker 新版 + web 旧版」的
   * 混合部署，破坏「同一 release 集合」。
   */
  imageEnvs?: string[];
  /** 目标镜像仓库（如 `ghcr.io/worable233/stackpanel`）；与计划 digest 拼成 `repo@sha256:...`。 */
  imageRepository: string;
  /** 允许自动更新的服务白名单（§5.1，默认只含 api/worker/web）。 */
  allowedServices: string[];
  database: DatabaseConfig;
  probes: ProbeConfig;
  /** updater 自身服务名（自升级时切换它）；缺省 `updater`。 */
  updaterService?: string;
  /** 承载 updater 镜像引用的环境变量名；缺省 `STACKPANEL_UPDATER_IMAGE`。 */
  updaterImageEnv?: string;
  /**
   * updater 镜像仓库（如 `ghcr.io/worable233/stackpanel-updater`）。
   *
   * 自升级的候选摘要必须与 **updater 自己的**仓库拼成 `repo@sha256:...`。此前复用了
   * 内核的 `imageRepository`（`.../stackpanel`），拉取的是内核镜像，`docker image inspect`
   * 自然找不到候选摘要 → 自升级在第一步就失败（恒报「候选镜像摘要不匹配」）。
   * 缺省时从当前 updater 镜像引用（取 `repo` 部分）推导，避免多配一个变量。
   */
  updaterImageRepository?: string;
  /**
   * 仓库在**宿主**上的绝对路径。
   *
   * 自升级要切换 updater 自己：在 updater 容器里直接跑 `compose up -d updater` 会
   * 在替换容器时把 CLI 一起杀掉（新容器停在 `Created`、旧容器 `Exited 137`）。因此
   * 切换必须交给一个**脱离本容器的临时助手容器**执行；助手需要以宿主的绝对路径挂载
   * 仓库，否则 compose 里的相对绑定路径会被解析到错误位置。缺省等于 `projectDir`。
   */
  hostProjectDir?: string;
  /** 快照/备份目录（updater 独立卷内）。缺省用 workDir/backups。 */
  backupDir?: string;
  /** 磁盘空间下限（字节）；不足则在停服前失败（§5.4-1）。 */
  minFreeBytes?: number;
}

const PLACEHOLDER = /[${}]/;

/**
 * 校验并规范化绑定配置。抛错即拒绝执行，避免在配置不完整时误操作宿主。
 */
export function validateComposeConfig(config: ComposeProjectConfig): ComposeProjectConfig {
  const problems: string[] = [];
  if (!config.projectName || PLACEHOLDER.test(config.projectName)) {
    problems.push('projectName 缺失或含未展开占位符');
  }
  if (!config.projectDir) problems.push('projectDir 缺失');
  if (!Array.isArray(config.composeFiles) || config.composeFiles.length === 0) {
    problems.push('composeFiles 为空');
  }
  for (const [key, value] of Object.entries(config.services)) {
    if (!value) problems.push(`services.${key} 缺失`);
  }
  if (!config.imageEnv) problems.push('imageEnv 缺失');
  if (!config.imageRepository) problems.push('imageRepository 缺失');
  if (config.allowedServices.length === 0) problems.push('allowedServices 为空');
  const managed = new Set([config.services.api, config.services.worker, config.services.web]);
  for (const service of managed) {
    if (!config.allowedServices.includes(service)) {
      problems.push(`允许清单缺少受管服务 ${service}`);
    }
  }
  if (!config.database.service || !config.database.user || !config.database.name) {
    problems.push('database 配置不完整');
  }
  if (!config.probes.readinessUrl) problems.push('probes.readinessUrl 缺失');
  if (config.probes.readyTimeoutMs !== undefined && !(config.probes.readyTimeoutMs > 0)) {
    problems.push('probes.readyTimeoutMs 必须为正数（毫秒）');
  }
  if (
    config.probes.readyPollIntervalMs !== undefined &&
    !(config.probes.readyPollIntervalMs > 0)
  ) {
    problems.push('probes.readyPollIntervalMs 必须为正数（毫秒）');
  }
  if (config.envFile !== undefined && config.envFile.trim().length === 0) {
    problems.push('envFile 为空字符串（要么不设，要么给路径）');
  }
  /**
   * 启动时就检查 env 文件可读性（P1-C）。
   *
   * 不可读时 compose 会把 `${POSTGRES_PASSWORD}` 之类的变量插值成**空串**，
   * 于是一次「成功」的升级会用空密码重建 api、把实例锁死。真机演练就重现过
   * （当时 `.env` 是 600 root:root，updater 读不到）。
   *
   * **fail-closed**：读不到就拒绝启动并给出修复指引，而不是等到升级中途才炸
   * —— 那时已经停服了。
   */
  if (config.envFile && !envFileReadable(config)) {
    problems.push(
      `env 文件不可读：${config.envFile}\n` +
        '   修复：确认 updater 容器内该路径可读，并把文件权限改为 640 root:docker，' +
        '同时给 updater 容器 group_add docker 组 ID。不要放到 world-readable' +
        '（里面是生成于安装时的密钥）。',
    );
  }
  if (problems.length > 0) {
    throw new Error(`部署配置无效：\n - ${problems.join('\n - ')}`);
  }
  return config;
}

/** env 文件是否存在且当前进程可读。 */
function envFileReadable(config: ComposeProjectConfig): boolean {
  const declared = config.envFile;
  if (!declared) return true;
  const resolved = path.isAbsolute(declared) ? declared : path.resolve(config.projectDir, declared);
  try {
    accessSync(resolved, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** 从环境变量装配绑定配置（`UPDATER_*`，见 README）。 */
export function composeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ComposeProjectConfig {
  const required = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`缺少环境变量 ${key}`);
    return value;
  };
  const services = {
    api: env['UPDATER_SERVICE_API'] ?? 'api',
    worker: env['UPDATER_SERVICE_WORKER'] ?? 'worker',
    web: env['UPDATER_SERVICE_WEB'] ?? 'web',
    migrate: env['UPDATER_SERVICE_MIGRATE'] ?? 'migrate',
  };
  // 迁移服务不在白名单里：它是 `restart: "no"` 的一次性任务，由 migrate 步骤
  // 单独 `run`，不该被 `up -d` 当成常驻服务拉起。
  const allowed = (env['UPDATER_ALLOWED_SERVICES'] ??
    [services.api, services.worker, services.web].join(','))
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const config: ComposeProjectConfig = {
    projectName: required('UPDATER_INSTANCE_ID'),
    projectDir: required('UPDATER_COMPOSE_PROJECT'),
    composeFiles: (env['UPDATER_COMPOSE_FILES'] ?? 'docker-compose.yml')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
    services,
    ...(env['UPDATER_ENV_FILE'] ? { envFile: env['UPDATER_ENV_FILE'] } : {}),
    imageEnv: env['UPDATER_IMAGE_ENV'] ?? 'STACKPANEL_IMAGE',
    // 可选的额外镜像变量（逗号分隔）。
    ...(env['UPDATER_IMAGE_ENVS']
      ? {
          imageEnvs: env['UPDATER_IMAGE_ENVS']
            .split(',')
            .map((name) => name.trim())
            .filter((name) => name.length > 0),
        }
      : {}),
    imageRepository: required('UPDATER_IMAGE_REPOSITORY'),
    ...(env['UPDATER_HOST_PROJECT_DIR'] ? { hostProjectDir: env['UPDATER_HOST_PROJECT_DIR'] } : {}),
    updaterService: env['UPDATER_SELF_SERVICE'] ?? 'updater',
    updaterImageEnv: env['UPDATER_SELF_IMAGE_ENV'] ?? 'STACKPANEL_UPDATER_IMAGE',
    ...(env['UPDATER_SELF_IMAGE_REPOSITORY']
      ? { updaterImageRepository: env['UPDATER_SELF_IMAGE_REPOSITORY'] }
      : {}),
    allowedServices: allowed,
    database: {
      service: env['UPDATER_DB_SERVICE'] ?? 'postgres',
      user: env['UPDATER_DB_USER'] ?? 'stackpanel',
      name: env['UPDATER_DB_NAME'] ?? 'stackpanel',
      // 设了 HOST 就走直连：数据库不在本 compose project 里时，
      // 「在 db 容器内跑 pg_dump」是不可能的。updater 镜像自带
      // postgresql-client，直接在自己进程里跑即可。
      ...(env['UPDATER_DB_HOST']
        ? {
            connection: {
              host: env['UPDATER_DB_HOST'],
              port: Number(env['UPDATER_DB_PORT'] ?? '5432'),
              user: env['UPDATER_DB_USER'] ?? 'stackpanel',
              name: env['UPDATER_DB_NAME'] ?? 'stackpanel',
              ...(env['UPDATER_DB_PASSWORD'] ? { password: env['UPDATER_DB_PASSWORD'] } : {}),
            },
          }
        : {}),
    },
    probes: {
      readinessUrl: env['UPDATER_READINESS_URL'] ?? 'http://api:3001/health',
      ...(env['UPDATER_LOGIN_PROBE_URL'] ? { loginProbeUrl: env['UPDATER_LOGIN_PROBE_URL'] } : {}),
      ...(env['UPDATER_WEB_URL'] ? { webUrl: env['UPDATER_WEB_URL'] } : {}),
      ...(env['UPDATER_READY_TIMEOUT_MS']
        ? { readyTimeoutMs: Number(env['UPDATER_READY_TIMEOUT_MS']) }
        : {}),
      ...(env['UPDATER_READY_POLL_INTERVAL_MS']
        ? { readyPollIntervalMs: Number(env['UPDATER_READY_POLL_INTERVAL_MS']) }
        : {}),
    },
  };
  if (env['UPDATER_MIN_FREE_BYTES']) {
    config.minFreeBytes = Number(env['UPDATER_MIN_FREE_BYTES']);
  }
  if (env['UPDATER_BACKUP_DIR']) {
    config.backupDir = env['UPDATER_BACKUP_DIR'];
  }
  return validateComposeConfig(config);
}
