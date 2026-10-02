<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 前端开发规范

## 样式

- **禁止自定义 CSS 文件和内联 `style` 属性**
- 只允许使用 **Tailwind CSS utility classes** 和 **shadcn/ui 组件 API**
- 需要自定义样式时，通过 Tailwind 的 `className` 组合实现，不写 `<style>` 或 `.css`
- 主题色/间距等通过 CSS Token（`theme.css` 的 `:root` / `.dark` 变量）配置，组件中用 `var(--token)` 引用

## 组件

- shadcn/ui 组件为复制式，装在 `src/components/ui/`
- `packages/ui` 只放跨应用共享的自定义组件
- Base UI **没有 `asChild`**，按钮做链接用：`<Button render={<Link href="/..." />} />`
  - `src/components/ui/button.tsx` 的包装会在传入 `render` 时自动设 `nativeButton={false}`；只有渲染真实 `<button>` 的自定义组件才需要显式覆写 `nativeButton`
