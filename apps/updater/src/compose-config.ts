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
  };
  const allowed = (env['UPDATER_ALLOWED_SERVICES'] ?? Object.values(services).join(','))
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
    imageEnv: env['UPDATER_IMAGE_ENV'] ?? 'STACKPANEL_IMAGE',
    imageRepository: required('UPDATER_IMAGE_REPOSITORY'),
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
