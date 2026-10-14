/**
 * StackPanel Design System - Clarity
 * 
 * 极简克制的设计系统
 * 统一的设计规范文档
 */

# Clarity Design System

StackPanel 的统一设计语言 - 专业、清晰、可信

---

## 🎨 设计原则

### 1. Less is More（少即是多）
- 克制使用动效，每个动画都有明确目的
- 大量留白，让内容呼吸
- 专注核心信息，去除装饰性元素

### 2. Clarity First（清晰优先）
- 清晰的视觉层次
- 易读的字体排版
- 明确的操作反馈

### 3. Trust Through Data（数据建立信任）
- 真实的指标展示
- 透明的定价信息
- 实时的系统状态

---

## 🎨 颜色系统

### 主色（Primary）
用于主要操作、链接、强调

```css
--primary-50: #f0f9ff;
--primary-600: #0284c7;  /* 主要使用 */
--primary-700: #0369a1;  /* hover 状态 */
```

### 中性色（Neutral）
用于文本、边框、背景

```css
--neutral-50: #fafafa;   /* 背景 */
--neutral-200: #e5e5e5;  /* 边框 */
--neutral-600: #525252;  /* 次要文本 */
--neutral-900: #171717;  /* 主要文本 */
```

### 使用规则
- **80%** 黑白灰
- **15%** 主色（primary）
- **5%** 强调色（仅CTA按钮）

---

## 📝 字体系统

### 字体栈
```css
font-family: 'Geist Sans', ui-sans-serif, system-ui, -apple-system, sans-serif;
```

### 字号层级

| 用途 | 类名 | 大小 |
|------|------|------|
| Hero 标题 | `text-5xl md:text-6xl lg:text-7xl` | 48-80px |
| H1 | `text-3xl md:text-4xl` | 30-36px |
| H2 | `text-2xl md:text-3xl` | 24-30px |
| H3 | `text-xl md:text-2xl` | 20-24px |
| 正文 | `text-base` | 16px |
| 小字 | `text-sm` | 14px |
| 数据 | `text-3xl font-bold tabular-nums` | 30px |

### 行高
- 标题：`leading-tight` (1.25)
- 正文：`leading-7` (1.75)

---

## 📏 间距系统

### Section 间距
```tsx
// 标准 section
className="py-24 md:py-32"

// 小 section  
className="py-16 md:py-20"
```

### 容器宽度
```tsx
// 标准容器
className="mx-auto max-w-6xl px-6"

// 窄容器（文章）
className="mx-auto max-w-4xl px-6"
```

### 元素间距
```tsx
// 卡片间距
className="gap-6 md:gap-8"

// 内容间距
className="space-y-8"
```

---

## 🎬 动效规范

### 时长
```tsx
fast:   150ms  // 按钮按下
base:   200ms  // 默认 hover
slow:   300ms  // 卡片移动
```

### 缓动函数
```tsx
ease-out  // 所有动画使用
```

### 标准动效

#### 按钮
```tsx
<Button className="
  transition-all duration-200
  hover:scale-[1.02]
  active:scale-[0.98]
  hover:shadow-lg
" />
```

#### 卡片
```tsx
<Card className="
  transition-all duration-300
  hover:-translate-y-2
  hover:shadow-xl
  hover:border-neutral-300
" />
```

#### 链接下划线
```tsx
<a className="
  relative
  after:absolute after:bottom-0 after:left-0
  after:h-px after:w-0 after:bg-current
  after:transition-all after:duration-300
  hover:after:w-full
" />
```

---

## 🧩 组件规范

### Card

#### 基础卡片
```tsx
<Card>
  <CardHeader>
    <CardTitle>标题</CardTitle>
    <CardDescription>描述</CardDescription>
  </CardHeader>
  <CardContent>
    内容
  </CardContent>
</Card>
```

#### 交互卡片
```tsx
<Card interactive>
  {/* 自动添加 hover 效果 */}
</Card>
```

### MetricCard

用于展示数据指标：

```tsx
<MetricCard
  icon={Server}
  value="2,456"
  label="在线服务器"
  trend="+12%"
/>
```

### StatusBadge

用于显示系统状态：

```tsx
<StatusBadge status="operational" />
<StatusBadge status="degraded" label="自定义文本" />
```

### Button

#### 主按钮
```tsx
<Button>
  操作
  <ArrowRight className="ml-2 size-4" />
</Button>
```

#### 次要按钮
```tsx
<Button variant="outline">
  次要操作
</Button>
```

---

## 📐 布局模式

### Hero Section
```tsx
<section className="
  relative flex min-h-screen items-center justify-center
  bg-white dark:bg-neutral-950
">
  {/* 背景网格 */}
  <div className="absolute inset-0 bg-[linear-gradient(...)]" />
  
  {/* 内容 */}
  <div className="relative z-10 mx-auto max-w-5xl px-6 text-center">
    {/* StatusBadge */}
    {/* Hero Title */}
    {/* CTA Button */}
  </div>
</section>
```

### Features Grid
```tsx
<section className="bg-neutral-50 py-24 md:py-32">
  <div className="mx-auto max-w-6xl px-6">
    <div className="grid gap-8 md:grid-cols-3">
      {/* Feature Cards */}
    </div>
  </div>
</section>
```

### Metrics Dashboard
```tsx
<div className="grid gap-6 md:grid-cols-4">
  <MetricCard />
  <MetricCard />
  <MetricCard />
  <MetricCard />
</div>
```

---

## 🚫 禁止事项

### ❌ 不要使用
- 内联 `style` 属性
- 自定义 CSS 文件
- 过度的动画效果
- 魔法UI组件（ShimmerButton、AuroraText等）
- 多个 CTA 按钮（一个页面只有一个主CTA）

### ✅ 应该使用
- Tailwind utility classes
- shadcn/ui 组件
- Clarity 自定义组件
- 简洁的 hover 效果
- 数据驱动的可信度

---

## 📱 响应式规范

### 断点
```
sm:  640px   // 手机横屏
md:  768px   // 平板
lg:  1024px  // 桌面
xl:  1280px  // 大屏
```

### 网格
```tsx
// 响应式网格
grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3

// 响应式间距
py-16 md:py-24 lg:py-32

// 响应式字体
text-4xl md:text-6xl lg:text-7xl
```

---

## 🎯 前后台一致性

### 统一使用
- 相同的颜色变量
- 相同的组件库
- 相同的动效时长
- 相同的间距系统

### 差异点
- 前台：更多留白，更大标题
- 后台：更紧凑，更多数据密度

---

## ✅ 检查清单

### 新页面检查
- [ ] 使用了 Card 组件而非 div
- [ ] 所有按钮有 hover/active 效果
- [ ] 响应式断点完整（mobile/tablet/desktop）
- [ ] 没有使用内联 style
- [ ] 没有堆砌动效
- [ ] 留白充足

### 组件检查
- [ ] 继承了设计系统的颜色
- [ ] 使用了统一的圆角（rounded-lg）
- [ ] 使用了统一的阴影（shadow-sm/lg/xl）
- [ ] transition-all duration-200/300

---

## 🔄 迁移指南

### 从旧代码迁移

#### Before
```tsx
<div className="space-y-1">
  <Component />
  <p className="text-xs">描述</p>
</div>
```

#### After
```tsx
<Card interactive>
  <CardHeader>
    <CardTitle>标题</CardTitle>
    <CardDescription>描述</CardDescription>
  </CardHeader>
  <CardContent>
    <Component />
  </CardContent>
</Card>
```

---

## 📚 参考资源

- **Linear**: 极简克制的典范
- **Stripe**: 清晰专业的典范
- **GitHub**: 功能实用的典范
- **shadcn/ui**: 组件设计参考

---

**最后更新**: 2024-12-19  
**版本**: 1.0.0
