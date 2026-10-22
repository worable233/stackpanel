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
  /** compose 服务名（在其容器内执行 pg_dump/pg_restore/psql）。 */
  service: string;
  user: string;
  name: string;
  /** 可选：数据库所属卷/挂载，用于磁盘空间估算。 */
  volume?: string;
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
  if (problems.length > 0) {
    throw new Error(`部署配置无效：\n - ${problems.join('\n - ')}`);
  }
  return config;
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
    imageRepository: required('UPDATER_IMAGE_REPOSITORY'),
    updaterService: env['UPDATER_SELF_SERVICE'] ?? 'updater',
    updaterImageEnv: env['UPDATER_SELF_IMAGE_ENV'] ?? 'STACKPANEL_UPDATER_IMAGE',
    allowedServices: allowed,
    database: {
      service: env['UPDATER_DB_SERVICE'] ?? 'postgres',
      user: env['UPDATER_DB_USER'] ?? 'stackpanel',
      name: env['UPDATER_DB_NAME'] ?? 'stackpanel',
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
