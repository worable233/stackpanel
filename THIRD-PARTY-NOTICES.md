# 第三方组件声明

StackPanel 的分发物中包含第三方开源组件。本文件列出这些组件、它们的许可证，以及分发时需要随附的声明。

完整的机器可读依赖清单由 CI 生成：`.github/workflows/ci.yml` 的 “Generate dependency SBOM” 步骤输出 `stackpanel-sbom.json` 并作为构建产物上传。

## 分发形式

| 分发物 | 内容 |
| --- | --- |
| npm 包 | `@stackpanel/sdk`、`@stackpanel/spec`、`@stackpanel/mcp` |
| 容器镜像 | `ghcr.io/worable233/stackpanel`（api / web / worker 共用同一镜像） |
| 插件与主题 ZIP | 由 `pnpm plugin:pack` 打包或后台上传产生 |

容器镜像在构建时执行 `pnpm install --prod`，只保留运行期需要的组件。运行期确实需要少量构建工具：API 容器的 `prisma migrate deploy` 使用 Prisma CLI，worker 在插件/主题前端变更时执行 `pnpm build:frontend` 与 `next build`。这些工具因此声明在 `dependencies` 中而非 `devDependencies`：Prisma CLI、Next、Tailwind、TypeScript、esbuild、Prettier。ESLint、Vitest、Playwright、PM2、license-checker 等开发期工具不随镜像分发。

## 一、运行期依赖

以下组件随分发物发布，均为宽松型许可证，保留其许可证与版权声明即可。

| 组件 | 版本 | 许可证 | 源码地址 |
| --- | --- | --- | --- |
| [@aws-sdk/client-s3](https://github.com/aws/aws-sdk-js-v3) | 3.1141.0 | Apache-2.0 |
| [@aws-sdk/s3-request-presigner](https://github.com/aws/aws-sdk-js-v3) | 3.1141.0 | Apache-2.0 |
| [@opentelemetry/api](https://github.com/open-telemetry/opentelemetry-js) | 1.9.1 | Apache-2.0 |
| [@opentelemetry/exporter-trace-otlp-http](https://github.com/open-telemetry/opentelemetry-js) | 0.222.0 | Apache-2.0 |
| [@opentelemetry/instrumentation-http](https://github.com/open-telemetry/opentelemetry-js) | 0.222.0 | Apache-2.0 |
| [@opentelemetry/resources](https://github.com/open-telemetry/opentelemetry-js) | 2.11.0 | Apache-2.0 |
| [@opentelemetry/sdk-node](https://github.com/open-telemetry/opentelemetry-js) | 0.222.0 | Apache-2.0 |
| [@opentelemetry/semantic-conventions](https://github.com/open-telemetry/opentelemetry-js) | 1.43.0 | Apache-2.0 |
| [@prisma/adapter-pg](https://github.com/prisma/prisma) | 7.9.1 | Apache-2.0 |
| [@prisma/client](https://github.com/prisma/prisma) | 7.9.1 | Apache-2.0 |
| [class-variance-authority](https://github.com/joe-bell/cva) | 0.7.1 | Apache-2.0 |
| [prisma](https://github.com/prisma/prisma) | 7.9.1 | Apache-2.0 |
| [prom-client](https://github.com/siimon/prom-client) | 15.1.3 | Apache-2.0 |
| [sharp](https://github.com/lovell/sharp) | 0.35.5 | Apache-2.0 |
| [typescript](https://github.com/microsoft/TypeScript) | 5.9.3 / 6.0.3 | Apache-2.0 |
| [dotenv](https://github.com/motdotla/dotenv) | 17.4.2 | BSD-2-Clause |
| [lucide-react](https://github.com/lucide-icons/lucide) | 0.468.0 | ISC |
| [lucide-react](https://github.com/lucide-icons/lucide) | 1.31.0 | ISC |
| [semver](https://github.com/npm/node-semver) | 7.8.5 | ISC |
| [@base-ui/react](https://github.com/mui/base-ui) | 1.6.0 | MIT |
| [@dnd-kit/core](https://github.com/clauderic/dnd-kit) | 6.3.1 | MIT |
| [@dnd-kit/sortable](https://github.com/clauderic/dnd-kit) | 10.0.0 | MIT |
| [@dnd-kit/utilities](https://github.com/clauderic/dnd-kit) | 3.2.2 | MIT |
| [@fastify/cookie](https://github.com/fastify/fastify-cookie) | 11.1.2 | MIT |
| [@fastify/cors](https://github.com/fastify/fastify-cors) | 11.3.0 | MIT |
| [@fastify/multipart](https://github.com/fastify/fastify-multipart) | 10.1.2 | MIT |
| [@fastify/rate-limit](https://github.com/fastify/fastify-rate-limit) | 11.2.0 | MIT |
| [@fastify/swagger](https://github.com/fastify/fastify-swagger) | 9.8.1 | MIT |
| [@fastify/swagger-ui](https://github.com/fastify/fastify-swagger-ui) | 6.1.1 | MIT |
| @radix-ui/react-icons | 1.3.2 | MIT |
| @stackpanel/mcp | 0.4.0 | MIT |
| @stackpanel/sdk | 0.4.0 | MIT |
| @stackpanel/spec | 0.4.0 | MIT |
| [@tailwindcss/postcss](https://github.com/tailwindlabs/tailwindcss) | 4.3.3 | MIT |
| [bullmq](https://github.com/taskforcesh/bullmq) | 6.3.10 | MIT |
| [clsx](https://github.com/lukeed/clsx) | 2.1.1 | MIT |
| [cn](https://github.com/shadcn-ui/cn) | 0.4.0 | MIT |
| [css-tree](https://github.com/csstree/csstree) | 3.2.1 | MIT |
| [emoji-picker-react](https://github.com/ealush/emoji-picker-react) | 4.22.3 | MIT |
| [esbuild](https://github.com/evanw/esbuild) | 0.27.7 | MIT |
| [fastify](https://github.com/fastify/fastify) | 5.12.5 | MIT |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT |
| [ioredis](https://github.com/redis/ioredis) | 6.0.0 | MIT |
| [jose](https://github.com/panva/jose) | 6.2.6 | MIT |
| [motion](https://github.com/motiondivision/motion) | 13.1.0 | MIT |
| [next](https://github.com/vercel/next.js) | 16.3.8 | MIT |
| [pg](https://github.com/brianc/node-postgres) | 8.23.0 | MIT |
| [prettier](https://github.com/prettier/prettier) | 3.9.6 | MIT |
| [react](https://github.com/facebook/react) | 19.2.4 | MIT |
| [react-dom](https://github.com/facebook/react) | 19.2.4 | MIT |
| [recharts](https://github.com/recharts/recharts) | 3.10.1 | MIT |
| [sanitize-html](https://github.com/apostrophecms/apostrophe) | 2.18.0 | MIT |
| server-only | 0.0.1 | MIT |
| [sonner](https://github.com/emilkowalski/sonner) | 2.0.8 | MIT |
| [tailwind-merge](https://github.com/dcastil/tailwind-merge) | 3.6.0 | MIT |
| [tailwindcss](https://github.com/tailwindlabs/tailwindcss) | 4.3.3 | MIT |
| [tw-animate-css](https://github.com/wombosvideo/tw-animate-css) | 1.4.0 | MIT |
| [zod](https://github.com/colinhacks/zod) | 4.4.3 | MIT |

## 二、需要随附声明的组件

以下组件使用宽松型以外的许可证，分发时需随附许可证全文与版权声明。许可证全文位于 [`licenses/`](licenses/)。

| 组件 | 版本 | 许可证 | 引入路径 | 义务与说明 |
| --- | --- | --- | --- | --- |
| `@img/sharp-libvips-linux-x64` / `-linux-arm64` / `-darwin-arm64` 等平台包 | 1.3.4 | LGPL-3.0-or-later | `sharp` → `apps/api` | 作为独立原生库在运行时动态加载，可单独替换；随附 [`licenses/LGPL-3.0-or-later.txt`](licenses/LGPL-3.0-or-later.txt)，源码见 https://github.com/lovell/sharp-libvips |
| `lightningcss`、`lightningcss-*` | 1.32.0 / 1.33.0 | MPL-2.0 | `@tailwindcss/postcss` → `apps/web`；worker 执行 `next build` 时运行 | 随附 [`licenses/MPL-2.0.txt`](licenses/MPL-2.0.txt)；未修改上游源码 |
| `elkjs` | 0.11.1 | EPL-2.0 | `@prisma/studio-core` → `prisma` → `packages/db` | 随附 [`licenses/EPL-2.0.txt`](licenses/EPL-2.0.txt) |
| `caniuse-lite` | 1.0.30001806 / 1.0.30001814 | CC-BY-4.0 | `next` / `browserslist` | 数据来自 https://caniuse.com ；随附 [`licenses/CC-BY-4.0.txt`](licenses/CC-BY-4.0.txt) |
| `mariadb` | 未安装 | LGPL-2.1-only | 官方 Prisma MySQL 适配器 | 仅作为 [`scripts/check-licenses.mjs`](scripts/check-licenses.mjs) 中的已备案例外保留 |

只存在于开发环境的组件不属于分发物：`pm2`（AGPL-3.0，仅供 `scripts/install.sh` 在宿主机拉起进程）、`axe-core`（MPL-2.0）与 `language-subtag-registry`（ODC-By-1.0，经 `eslint-config-next`）、`spdx-exceptions` / `spdx-ranges`（经 `license-checker`）都不随镜像或 npm 包发布。

## 三、字体

界面字体 Geist 与 Geist Mono 以 woff2 形式内置于 `apps/web/src/fonts/`，采用 SIL Open Font License 1.1，版权归 Vercel, Inc. 与 basement.studio 所有。许可证全文见 [`apps/web/src/fonts/LICENSE.txt`](apps/web/src/fonts/LICENSE.txt) 或 [`licenses/OFL-1.1.txt`](licenses/OFL-1.1.txt)。

## 四、本项目自身许可证

StackPanel 以 MIT 许可证发布，见 [LICENSE](LICENSE)。`@stackpanel/sdk`、`@stackpanel/spec`、`@stackpanel/mcp` 三个 npm 包各自附带一份 [LICENSE](LICENSE)。

## 五、已知限制

- 平台原生包按运行环境选择安装：常规 macOS 开发机只安装 `@img/sharp-libvips-darwin-arm64`，容器镜像安装 `@img/sharp-libvips-linux-*`。二者许可证相同，均为 LGPL-3.0-or-later。
- 通用许可证工具不遍历 `optionalDependencies`，因此 [`.github/workflows/ci.yml`](.github/workflows/ci.yml) 的许可证检查除遍历已安装依赖外，还会扫描 `pnpm-lock.yaml`，以便在任意平台上都能看到未安装的平台原生包。
- `next` 把 `@playwright/test` 声明为可选 peer，锁文件据此固定了带 peer 后缀的版本，因此 `@playwright/test`（Apache-2.0）仍会随镜像安装，即使它只用于测试。
- 少数历史包没有声明许可证字段，只能从 `LICENSE` 文件判断（例如仅经开发依赖链引入的 `abbrev@1.0.3`）。
- 仓库内的主题与图标均为自制资源。第三方商标、认证标识与客户标识不随仓库分发。

## 六、许可证检查

`pnpm license:check` 执行 [`scripts/check-licenses.mjs`](scripts/check-licenses.mjs)：

1. 用 `pnpm licenses list` 遍历已安装的依赖树（含 `optionalDependencies`）。
2. 扫描 `pnpm-lock.yaml`，覆盖当前未安装的平台原生包。
3. 任何非宽松许可证都必须同时出现在脚本的 `DOCUMENTED_EXCEPTIONS` 表中，否则检查失败。

CI 在 [`.github/workflows/ci.yml`](.github/workflows/ci.yml) 中运行同一条命令，并在前置步骤用 `pnpm sbom --sbom-format cyclonedx` 生成 SBOM 作为构建产物上传。
