/**
 * Clarity Design System
 * 
 * StackPanel 统一设计系统 - 极简克制风格
 * 参考：Linear、Stripe、GitHub
 */

// ============================================================================
// 排版系统
// ============================================================================

export const typography = {
  // Hero 大标题
  hero: 'text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight',
  
  // 标题层级
  h1: 'text-3xl md:text-4xl font-semibold tracking-tight',
  h2: 'text-2xl md:text-3xl font-semibold tracking-tight',
  h3: 'text-xl md:text-2xl font-semibold',
  h4: 'text-lg md:text-xl font-semibold',
  
  // 正文
  body: 'text-base leading-7',
  bodyLarge: 'text-lg leading-8',
  bodySmall: 'text-sm leading-6',
  caption: 'text-xs leading-5',
  
  // 特殊用途
  metric: 'text-2xl md:text-3xl font-bold tabular-nums',
  code: 'font-mono text-sm',
} as const;

// ============================================================================
// 间距系统
// ============================================================================

export const spacing = {
  // Section 间距
  section: 'py-16 md:py-24 lg:py-32',
  sectionSmall: 'py-12 md:py-16 lg:py-20',
  
  // 容器
  container: 'mx-auto max-w-6xl px-6',
  containerWide: 'mx-auto max-w-7xl px-6',
  containerNarrow: 'mx-auto max-w-4xl px-6',
  
  // 内边距
  card: 'p-6 md:p-8',
  cardSmall: 'p-4 md:p-6',
  
  // 间隙
  gap: 'gap-6 md:gap-8',
  gapSmall: 'gap-4 md:gap-6',
  gapLarge: 'gap-8 md:gap-12',
} as const;

// ============================================================================
// 动效系统
// ============================================================================

export const transitions = {
  fast: 'duration-150',
  base: 'duration-200',
  slow: 'duration-300',
  slower: 'duration-500',
} as const;

export const animations = {
  // 按钮交互
  button: 'transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]',
  
  // 卡片交互
  card: 'transition-all duration-300 hover:-translate-y-2 hover:shadow-xl',
  cardSubtle: 'transition-all duration-300 hover:-translate-y-1 hover:shadow-lg',
  
  // 链接下划线
  linkUnderline: 'relative after:absolute after:bottom-0 after:left-0 after:h-px after:w-0 after:bg-current after:transition-all after:duration-300 hover:after:w-full',
  
  // 淡入淡出
  fadeIn: 'animate-in fade-in',
  fadeOut: 'animate-out fade-out',
  
  // 滑入
  slideInFromTop: 'animate-in slide-in-from-top-2',
  slideInFromBottom: 'animate-in slide-in-from-bottom-2',
} as const;

// ============================================================================
// 颜色语义化
// ============================================================================

export const colors = {
  // 文本
  text: {
    primary: 'text-neutral-900 dark:text-white',
    secondary: 'text-neutral-600 dark:text-neutral-400',
    tertiary: 'text-neutral-500 dark:text-neutral-500',
    inverse: 'text-white dark:text-neutral-900',
  },
  
  // 背景
  bg: {
    primary: 'bg-white dark:bg-neutral-950',
    secondary: 'bg-neutral-50 dark:bg-neutral-900',
    tertiary: 'bg-neutral-100 dark:bg-neutral-800',
    inverse: 'bg-neutral-900 dark:bg-white',
  },
  
  // 边框
  border: {
    default: 'border-neutral-200 dark:border-neutral-800',
    hover: 'hover:border-neutral-300 dark:hover:border-neutral-700',
    focus: 'focus:border-primary-500 dark:focus:border-primary-400',
  },
  
  // 状态
  status: {
    success: 'text-green-600 dark:text-green-400',
    warning: 'text-yellow-600 dark:text-yellow-400',
    error: 'text-red-600 dark:text-red-400',
    info: 'text-blue-600 dark:text-blue-400',
  },
} as const;

// ============================================================================
// 组件基础样式
// ============================================================================

export const components = {
  // 卡片基础
  card: `rounded-lg border ${colors.border.default} ${colors.bg.primary} ${spacing.card}`,
  cardInteractive: `rounded-lg border ${colors.border.default} ${colors.bg.primary} ${spacing.card} cursor-pointer ${animations.cardSubtle}`,
  
  // 输入框基础
  input: `w-full rounded-md border ${colors.border.default} ${colors.bg.primary} px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/50`,
  
  // 标签
  badge: 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
  
  // 分隔线
  divider: `border-t ${colors.border.default}`,
} as const;

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 合并类名（简化版 cn）
 */
export function cx(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}

/**
 * 构建响应式网格
 */
export function grid(cols: { mobile?: number; tablet?: number; desktop?: number } = {}) {
  const { mobile = 1, tablet = 2, desktop = 3 } = cols;
  return `grid grid-cols-${mobile} md:grid-cols-${tablet} lg:grid-cols-${desktop}`;
}
