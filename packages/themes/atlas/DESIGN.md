# Atlas 主题设计标准

Atlas 是 StackPanel 的黑白灰产品店面与后台主题。目标不是“做得很酷”，而是让商品、价格和操作在任何页面都保持同一种秩序：**白底、柔和灰块、清楚的字号层级、克制的动效**。

本文是 Atlas 的视觉与组件规范。新增页面、插件后台页或修改现有页面时，按此文档判断，不以个人偏好覆盖。

---

## 1. 设计关键词

- **Monochrome**：黑、白、灰为主；颜色只用于状态（成功、警告、错误），不用于装饰。
- **Borderless**：不用可见边框和阴影区分层级，用底色、圆角、留白和字重。
- **Quiet**：不堆渐变、光效、玻璃拟态、彩色图标底、悬浮上浮。
- **Consistent**：同类信息用同一种结构；标题层级、卡片内边距、间距全站一致。
- **Server-safe**：主题前端由宿主 RSC loader 加载，页面与布局不能使用 `'use client'`、hooks、context。

---

## 2. 颜色与 Token

所有颜色必须来自 `theme.css` 的语义 token；禁止在组件里写 `bg-gray-100`、`#f5f5f5`、`text-blue-500` 之类的原始颜色。

| Token | Light | 用途 |
| --- | --- | --- |
| `--background` | `#ffffff` | 页面底色 |
| `--foreground` | `#0a0a0a` | 主文字 |
| `--muted` | `#f5f5f5` | 柔和灰块、hover、次级面板 |
| `--muted-foreground` | `#737373` | 说明文字、辅助信息 |
| `--card` | `#ffffff` | 卡片表面 |
| `--primary` | `#0a0a0a` | 主按钮、强调数字 |
| `--destructive` | `#dc2626` | 错误、到期、危险操作 |
| `--success` | `#16a34a` | 正常、运行中 |
| `--input` | `#e5e5e5` | 输入框细边框 |
| `--radius` | `0.625rem` | 基础圆角 |

规则：

- 大面积背景只用 `bg-background`、`bg-muted`、`bg-muted/55`。
- 文字层级用 `text-foreground`、`text-muted-foreground`，不要靠降低透明度制造层级。
- 状态色只出现在图标、数字、Badge 或短提示中，不要整块铺色。
- 深色模式由 `.dark` token 自动承接；组件里不要写 `dark:` 颜色分支。

---

## 3. 字体与字号

宿主目前加载 Geist。Atlas 不假设可以使用其他字体；不要引入字体文件或 `@font-face`。

| 层级 | 用法 |
| --- | --- |
| 页面标题 | `PageHeader`，`text-2xl font-semibold tracking-tight` |
| 区块标题 | `SectionTitle`，`text-base font-semibold` |
| 卡片标题 | `CardTitle`，`text-sm font-semibold` |
| 正文 | `text-sm leading-6` |
| 辅助文字 | `text-xs` 或 `text-sm text-muted-foreground` |
| 金额/指标 | `text-3xl font-semibold tabular-nums` |

不要用全大写英文 eyebrow 当标题；不要用字号很小的灰色说明文字冒充标题。

---

## 4. 标题层级规范（重点）

Atlas 只有三种合法标题层级：

```
PageHeader（页面级 H1）
└── SectionTitle（内容区块级 H2，带圆形图标徽章）
    └── Card（内容容器）
        └── CardTitle（卡片内部 H3）
```

### 4.1 PageHeader：页面标题

- 每个页面最多一个。
- 只保留主标题，不显示 `eyebrow`、`description` 或标题上方的小字。
- 页面级操作放在 `actions`。
- 禁止把 `SectionTitle` 当页面标题使用。
- 列表页保持「PageHeader → 筛选器 → 列表」；不要额外堆大号统计卡、说明面板或多层灰底容器。

```tsx
<PageHeader title={t('account.notifications.title')} />
```

### 4.2 SectionTitle：区块标题

`SectionTitle` 是**页面 / section 级标题**，不是卡片标题。它有两种标准形态：

```tsx
<SectionTitle icon={<Gift />}>{t('rules.title')}</SectionTitle>
<SectionTitle>{t('admin.settings.platform.title')}</SectionTitle>
```

使用规则：

1. `SectionTitle` 必须是 `<main>` 或 `<section>` 的直接子元素。
2. `SectionTitle` 与它管理的 `Card` / 表格 / 表单是**兄弟关系**，标题在卡片上方。
3. 一个 section 一个 `SectionTitle`；不要在 CardHeader 里重复标题。
4. 需要右侧操作时，把标题和按钮放在同一个 header row，卡片仍然在下面。

```tsx
<section className="flex flex-col gap-4">
  <div className="flex items-center justify-between gap-4">
    <SectionTitle icon={<Gift />}>{t('rules.title')}</SectionTitle>
    <Button variant="outline" size="sm">{t('rules.edit')}</Button>
  </div>
  <Card>
    <CardContent>...</CardContent>
  </Card>
</section>
```

### 4.3 正确设计

```
┌─────────────────────────────────────────────┐
│  ◉ 奖励规则                    [编辑]       │  ← SectionTitle 在 section 上
├─────────────────────────────────────────────┤
│  ┌───────────────────────────────────────┐  │
│  │  奖励内容……                            │  │  ← Card 在标题下面
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

```tsx
// ✅ 正确：SectionTitle 挂在 section 上，Card 是它的兄弟
<section className="flex flex-col gap-4">
  <SectionTitle icon={<Gift />}>{tr('rules.title')}</SectionTitle>
  <Card>
    <CardContent className="pt-6">
      {tr('rules.body')}
    </CardContent>
  </Card>
</section>
```

### 4.4 错误设计

```
┌─────────────────────────────────────────────┐
│  ┌───────────────────────────────────────┐  │
│  │ ◉ 奖励规则                            │  │  ← 标题被塞进灰色卡片头
│  │                                       │  │
│  │ 奖励内容……                            │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

```tsx
// ❌ 错误：SectionTitle 塞进 Card / CardHeader
<Card>
  <CardHeader>
    <SectionTitle icon={<Gift />}>{tr('rules.title')}</SectionTitle>
  </CardHeader>
  <CardContent>
    {tr('rules.body')}
  </CardContent>
</Card>
```

为什么错误：

- `SectionTitle` 的圆形图标徽章和主色会与卡片的灰色头部叠在一起，出现“标题在卡片里”的错误层级。
- 同一页面多个区块会变成一堆各自带标题的卡片，扫读时找不到页面结构。
- 卡片头只应服务于“这一张卡内部”的信息，不应承担页面章节标题。

### 4.5 CardTitle：卡片内部标题

卡片内部的标题使用 `CardTitle`，不要再放圆形图标徽章。

```tsx
<Card>
  <CardHeader>
    <CardTitle>{t('account.home.securityTitle')}</CardTitle>
  </CardHeader>
  <CardContent>...</CardContent>
</Card>
```

判断口诀：

> **圆形图标徽章 + 章节标题 → SectionTitle，必须在卡片外面。**
> **卡片自己的标题 → CardTitle，可以放在 CardHeader 里。**

---

## 5. 面与边框

Atlas 的层级不靠边框和阴影：

- 页面：`bg-background`
- 柔和分区：`bg-muted/55`
- 卡片/面板：`bg-muted/55` 或 `bg-card`，圆角 `rounded-xl` / `rounded-[14px]`
- hover：`hover:bg-muted` 或 `hover:bg-background`
- 不使用 `shadow-*`、`hover:-translate-y-*`、发光边框、渐变描边
- 卡片不要额外加 1px 可见边框

例外：输入框、文本域、下拉框可以使用 1px `--input` 细边框，保证可编辑区域可辨认。

---

## 6. 间距与布局

- 页面内容宽度：`mx-auto w-full max-w-6xl px-4 sm:px-6`
- 页面区块间距：`gap-6` / `py-16`
- 卡片内边距：`p-5`；卡片内容区 `px-4` 或 `p-5`
- 卡片网格：`gap-3` 或 `gap-4`
- 一级导航项间距：统一 `gap-2`；分组容器使用同一个间距，不额外放大
- 优先使用 `gap-*`，不要用 `space-y-*`

后台布局：

- 左侧栏 `240px`，收起 `64px`
- 侧栏与画布使用统一灰底，不叠两层不同灰度
- 主内容在白色圆角画布内滚动
- 侧栏一级项高度一致，展开二级菜单不改变一级项自身高度

---

## 7. 组件规范

### Button

- 主操作：默认黑色 `primary`
- 次操作：`secondary` 或 `outline`，背景用 `bg-muted`
- 文字操作：`ghost`
- 不使用彩色按钮；危险操作才用 `destructive`

### Badge

- 库存、状态、能力标签使用 `Badge`
- 默认浅灰底；缺货/错误用浅红底
- 不要在文字前手写彩色圆点当状态

### Tabs

- 使用 shadcn / Base UI Tabs
- 分段控件放在浅灰底容器内，选中项白底
- 不手写两套高亮指示器

### Input

- 白底、1px `--input` 边框、`10px` 圆角、`40px` 高
- focus 只保留一层淡 ring
- 不要内外两层 focus ring

### Table

- 表头浅灰底，行之间用隔行底色或留白区分
- 不使用 `divide-y` 和 1px 边框网格
- 数字右对齐，金额使用 `tabular-nums`

---

## 7.1 Animate UI 组件约定

Atlas 的交互组件优先使用 **Animate UI Base UI** primitives，而不是原生控件或默认 shadcn 样式。宿主统一在 `packages/ui`、`apps/web` 建立桥接，页面只使用语义组件。

| 场景 | 组件 |
| --- | --- |
| 下拉选择 | Animate UI `Select` |
| 开关设置 | Animate UI `Switch` |
| 标签切换 | Animate UI `Tabs` |
| 侧边栏 | Animate UI `Sidebar`（Provider / Container / Highlight） |
| 右侧配置面板 | Animate UI `Sheet`（`side="right"`） |
| 数值范围 | Animate UI `Slider` |
| 图标按钮提示 | Animate UI `Tooltip` |
| 删除等二次确认 | Animate UI `AlertDialog` |
| 状态提示 | Animate UI `Toast` |
| 复制操作 | Animate UI `CopyButton` |
| 危险操作确认 | Animate UI `AlertDialog` |
| 多选/单选分段 | Animate UI `ToggleGroup` / `RadioGroup` |
| 多选筛选 | `ToggleGroup`（多选）/ `Select`（单选） |
| 单选卡片 | `RadioGroup` |

### 7.2 操作反馈

- 列表行操作、批量操作的成败使用系统 `Toast`，不要往页面或表格上方插入成功/失败提示条。
- 只有需要用户就地修正字段的校验错误才内联展示。
- 设置页的保存栏可以保留行内保存状态，因为它与保存按钮属于同一个操作区。

规则：

- 不直接写原生 `<select>`、`<input type="range">`、`<input type="checkbox">`。
- 组件不绑定 Atlas：写成通用语义封装，主题只负责 token 与样式。
- 触发器、弹层、勾选指示器都使用同一套圆角、间距和 hover 色。
- 弹层宽度跟随触发器，选项文字不能截断；空值要有占位文案。
- 禁用态、错误态、只读态保持可辨认，不靠降低透明度隐藏信息。

## 7.2 动效曲线

使用 Animate UI 官网的克制曲线，不添加弹跳和大幅位移。

| 动作 | 时长 | 曲线 |
| --- | --- | --- |
| hover / 颜色 | 150ms | `ease-out` |
| 页面切换 | 200ms | `[0.22, 1, 0.36, 1]` |
| 弹层 / Sheet | 240ms | `[0.22, 1, 0.36, 1]` |
| 侧栏展开 | 200–240ms | `ease-out` |
| 勾选绘制 | 300ms | `ease-out` |

- 页面切换：淡入 + 4px 内位移，不模糊、不缩放。
- 侧栏：Gap / Container / Highlight 使用同一条曲线，标签淡出与图标切换同步。
- Tooltip：只做 100–150ms 淡入，不移位。
- 所有动效尊重 `prefers-reduced-motion`。

## 7.3 侧边栏

- 使用 Animate UI Sidebar，而不是自绘宽度动画。
- 一级项高度一致、间距一致；展开二级菜单不改变一级项高度。
- 菜单悬停使用一个滑动高亮层；active 只保留一层背景，不要叠加两套指示器。
- **不要添加 “Projects”、“Workspace” 这类分组小标题**；菜单结构本身已经足够。
- 收起状态只显示图标，用 Tooltip 或展开标签补充文字。

## 7.4 Tooltip

Tooltip 只解释“这个图标是什么”或“这个操作会发生什么”，不写废话。

必须加：

- 只有图标的顶栏按钮：帮助、通知、语言、账户、侧栏折叠。
- 收起的侧边栏菜单项。
- 图标型行操作：编辑、删除、复制、刷新、更多。
- 状态图标、外部链接图标。

不要加：

- 已经有完整文字的按钮。
- 内容重复的提示。
- 营销式说明、长段落。

所有 Tooltip 文案走 i18n，四种语言完整；缺失时宁可先不加。

### 设置页

- 主设置页使用左侧 Tabs，内容区只保留一个主操作区。
- 插件设置页使用同一套 Tabs + 分组面板；只有一个分组时不显示无意义 Tabs。
- 分组用 `bg-muted/40` 圆角和留白分组，不加边框。
- 字段统一两列网格；布尔开关和列表字段占满整行。
- 保存栏固定在内容底部，错误/成功提示与按钮同一行。
- 没有设置项时显示居中的软灰空状态，不放一大段裸文字。
- 支付、币种、分发源等表格使用圆角灰底容器，不使用 border/divide-y。

### 更新页

- 首屏只展示当前版本、更新状态、检查更新/立即更新按钮。
- 版本号使用大字号，可用更新用高对比 Badge。
- 更新内容只列组件名称、类型、旧版本 → 新版本，不展示 digest、generation、sequence 等内部字段。
- 内部字段、目录仓状态、自升级和历史记录放进「高级信息」右侧 Sheet。
- 错误默认显示可理解的提示，技术详情折叠在 `details` 中。

## 7.5 Sheet / Drawer

- 右侧配置、筛选、详情使用 `Sheet side="right"`。
- 移动端导航使用左侧 Sheet。
- Sheet 头部只保留标题和关闭按钮，不放说明小字。
- 内容区使用统一 `p-5` 和 `gap-4`，底部操作固定。
- 不使用 Dialog 承担大段配置；Dialog 只用于短确认或短表单。
- 删除、停用、退款等不可逆操作使用 `AlertDialog`。

## 7.6 分页与数据量

禁止“固定取最新 N 条，用户永远看不到其余数据”。

- 列表必须读取 `page` / `pageSize`，展示 `total` 和页码。
- 默认页大小 20；可选 20 / 50 / 100。
- 后端 finder 必须返回 `total`、`page`、`pageSize`，而不是只返回数组。
- 筛选、搜索、排序改变时重置到第 1 页，并保留筛选参数。
- 分页控件使用 Animate UI Pagination 或统一的分页条；上一页/下一页需要禁用态。
- 移动端分页条可简化为“上一页 / 页码 / 下一页”。

## 7.7 Switch / Toggle / Radio

- **Switch**：立即生效的二元设置，例如启用通知、开启代理。
- **Toggle**：工具按钮的按下状态，例如加粗、仅看未读。
- **ToggleGroup**：少量并列选项，可单选或多选，例如时间范围、状态筛选。
- **RadioGroup**：互斥且需要解释的选项，例如部署区域、计费周期。
- **Checkbox**：表单提交前的多项确认，不是即时设置。
- 不要用 Checkbox 代替即时开关，也不要用 Switch 提交表单。

## 7.8 已踩坑记录

- `DropdownMenuTrigger` 外层再套 `TooltipTrigger` 可能导致点击落到错误目标；需要 Tooltip 时优先改造按钮组件本身，或改用安全的 trigger 组合，改完必须实际点击验证。
- Animate UI Select 若不传 `items`，触发器会显示原始 value 而不是标签；空字符串选项需要显式 placeholder。
- 使用 `cn` 拼接组件类名时如果没有 tailwind-merge，宽度/高度等冲突类不会互相覆盖；交互组件要使用 `twMerge`。
- 主题前端是 server module，Animate UI 客户端 primitive 必须通过宿主桥接导入，不能直接打进主题包。
- 侧边栏 Provider 与菜单结构必须保持同一套状态；不要同时维护两套 collapsed / open 状态。

---

## 8. 后台与插件页面

插件页面只负责结构和语义，视觉由宿主的 `.plugin-*` class 和主题 token 控制。

- 使用 `.plugin-section`、`.plugin-panel`、`.plugin-row`、`.plugin-table-wrap`、`.plugin-input` 等语义 class
- 不在插件源码里写 `bg-card`、`border`、`rounded-*`、`shadow-*`
- 不写原始颜色
- 插件后台卡片同样遵守 SectionTitle 规则：**标题在卡片外，卡片内用 CardTitle**

---

## 9. 动效

- 只做必要的状态过渡：`transition-colors`、展开/收起、Tabs 切换
- 时长 `150–200ms`，缓动 `ease-out`
- 不加入场模糊、位移、透明度瀑布
- 不做鼠标跟随光效、悬浮上浮、阴影放大
- 尊重 `prefers-reduced-motion`

---

## 10. 文案与 i18n

- 所有可见文案走 i18n，不允许硬编码中文或英文
- 只手写 `zh-CN`、`en-US`；`zh-TW` / `zh-HK` 由 `scripts/i18n-hant.mjs` 生成
- 文案面向客户部署后的真实使用场景，不介绍 StackPanel 项目本身
- 标题短、动词明确；说明文字只补充必要信息
- 后台页面标题区域不加“订单支付、履约进度……”这类说明小字

---

## 11. 禁止清单

- ❌ 在 `Card` / `CardHeader` 里放 `SectionTitle`
- ❌ 用 `SectionTitle` 当页面 H1
- ❌ 页面标题上方加 eyebrow / description / 小标题
- ❌ 1px 可见卡片边框、阴影、hover 上浮
- ❌ 渐变、光效、玻璃拟态、彩色装饰块
- ❌ 原始颜色值、`bg-gray-*`、`text-blue-*`
- ❌ 自定义 CSS、内联 `style`
- ❌ 主题页面里使用 `'use client'`、hooks、context
- ❌ 手改 `frontend/manifest.json`

---

## 12. Review Checklist

提交页面前逐项检查：

- [ ] 页面只有一个 `PageHeader`，且没有标题小字
- [ ] 每个区块的 `SectionTitle` 在 `main` / `section` 上，不在 Card 里
- [ ] 卡片内部标题使用 `CardTitle`
- [ ] 没有可见卡片边框、阴影、上浮
- [ ] 颜色全部来自 token
- [ ] 间距使用 `gap-*`，同类区块间距一致
- [ ] 输入框只有一层 focus ring
- [ ] 文案全部走 i18n
- [ ] 主题前端保持 server-safe
- [ ] `tsc`、`pnpm build:frontend`、i18n 检查通过
