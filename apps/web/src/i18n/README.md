# 前端界面多语言（ADR-0016）

内核自带的界面文案层。**不做 locale 前缀 URL**：语言由 `sp_locale` cookie 与
`Accept-Language` 协商，页面内切换；国际站按「一语言一站」独立部署。

## 组成

| 文件                | 作用                                                                 |
| ------------------- | -------------------------------------------------------------------- |
| `config.ts`         | 已发布语言 `LOCALES`、默认语言、cookie 名、各语言消息目录            |
| `core.ts`           | 点分 id 查找、`{name}` 插值、回退链、`Intl` 数字/日期/货币格式化     |
| `negotiate.ts`      | `Accept-Language` 解析与最佳匹配（精确 tag → 同语言基 → 默认）        |
| `locale.ts`         | 服务端 `getLocale()`：cookie → 协商 → 默认（`server-only`）          |
| `provider.tsx`      | 客户端 `I18nProvider` / `useTranslator()` / `useLocale()`            |
| `actions.ts`        | `setLocaleAction`：写 cookie 的服务端动作（不落 URL）                |
| `nav.ts`            | 内核导航 `href` → 消息 id 映射（API 只回稳定 href，UI 负责文案）      |
| `messages/<locale>.json` | 各语言消息目录，键为稳定 id，值为该语言文案                     |

## 消息目录约定

- 键：稳定、语言无关的点分 id，例如 `auth.login.title`、`error.auth.invalid_credentials`。
- 回退链：请求语言 → 站点默认语言 → 键本身；开发态缺失键 `console.warn`，不静默吞掉。
- API 一律返回稳定 `code` 与中性英文 `title/detail`；**UI 按 `error.<code>` 本地化**（ADR-0012 + ADR-0016 §3）。
- **zh-CN 与 en-US 键集合必须完全一致**，由 `tests/i18n-catalog.test.ts` 强制。
- 新增语言：新增 `messages/<locale>.json` 并在 `config.ts` 的 `LOCALES` / `CATALOGS` 登记。

## 使用

服务端组件：

```ts
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';

const locale = await getLocale();
const title = translate(locale, 'auth.login.title');
```

客户端组件（在 `I18nProvider` 之下，根布局已注入）：

```ts
import { useTranslator, useLocale } from '@/i18n/provider';

const t = useTranslator();
const locale = useLocale();
```

语言切换控件：`@/components/locale-switcher`（web 绑定）包装
`@stackpanel/ui` 的 `LocaleSwitcher` 原语（无文案、只负责呈现）。

## 边界（非目标）

- 不做内容多语言（文章/商品翻译表与工作流）。
- 不做 URL 语言前缀、hreflang、多语言 sitemap。
- 主题 / 插件前端自带的界面文案暂不接管；待 manifest `locales`（ADR-0016 §5）落地后再接入。
