/**
 * 首页动效样式表。
 *
 * @i18n-exempt 纯 CSS：不含任何面向用户的文案，只有选择器、keyframes 和属性。
 *
 * 为什么不写在 `theme.css`：那个文件只允许 `:root` / `.dark` 的 token 声明
 * （契约 05 §3.3 有校验），主题前端包也不参与宿主的 Tailwind 扫描，所以首页
 * 需要的那几个 keyframes 只能随页面内联。全部类名以 `atl-` 为前缀，避免和
 * 宿主、插件的类名撞车；所有动效都在 `prefers-reduced-motion: reduce` 下关闭，
 * 隐藏式入场额外用 `@media (scripting: none)` 兜底，禁 JS 时内容仍然可见。
 */
export const MOTION_CSS = `
@keyframes atl-travel {
  0% { left: 0; opacity: 0; }
  10% { opacity: 1; }
  86% { opacity: 1; }
  100% { left: 100%; opacity: 0; }
}
@keyframes atl-ping {
  0% { transform: scale(0.94); opacity: 0.45; }
  70% { transform: scale(1.28); opacity: 0; }
  100% { transform: scale(1.28); opacity: 0; }
}
@keyframes atl-drift {
  to { background-position: 22px 22px; }
}
@keyframes atl-blink {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 1; }
}
@keyframes atl-ticker {
  to { transform: translateX(-50%); }
}
/* 只动 transform，不动 opacity：滚动时间线一旦算不出进度，内容也必须是可见的。 */
@keyframes atl-scroll-in {
  from { transform: scale(0.97); }
  to { transform: none; }
}
/* 聚光：进入视口中段最实，进出两端稍淡，读起来像「当前在讲这一条」。 */
@keyframes atl-spot {
  0% { opacity: 0.55; }
  30% { opacity: 1; }
  70% { opacity: 1; }
  100% { opacity: 0.55; }
}
@keyframes atl-scroll-fade {
  from { transform: translateY(18px); }
  to { transform: none; }
}

/* 连线：1px 的容器裁掉溢出的光点，光点沿自身宽度百分比移动。 */
.atl-line {
  position: relative;
  overflow: hidden;
}
.atl-packet {
  position: absolute;
  top: 50%;
  left: 0;
  width: 5px;
  height: 5px;
  margin-top: -2.5px;
  border-radius: 999px;
  background: var(--foreground);
  animation: atl-travel 2.8s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite;
}
/* 信号线：渐变发丝线，两端淡出，比纯 bg-border 更像「通路」而不是分隔线。 */
.atl-wire {
  background-image: linear-gradient(
    90deg,
    transparent,
    var(--border) 12%,
    var(--border) 88%,
    transparent
  );
}

.atl-ping {
  animation: atl-ping 3.4s ease-out infinite;
}
.atl-grid {
  background-image: radial-gradient(var(--border) 1px, transparent 1px);
  background-size: 22px 22px;
  animation: atl-drift 16s linear infinite;
  mask-image: radial-gradient(72% 62% at 50% 42%, #000 38%, transparent 100%);
  -webkit-mask-image: radial-gradient(72% 62% at 50% 42%, #000 38%, transparent 100%);
}
.atl-blink {
  animation: atl-blink 2.4s ease-in-out infinite;
}

/* logo 墙：两份等宽副本 + translateX(-50%) 才能无缝接上。 */
.atl-ticker-mask {
  mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent);
}
.atl-ticker {
  display: flex;
  width: max-content;
  animation: atl-ticker 38s linear infinite;
}
.atl-ticker-mask:hover .atl-ticker {
  animation-play-state: paused;
}

/* 滚动驱动（渐进增强）：不支持时退回静态，内容不会丢。 */
@supports (animation-timeline: view()) {
  .atl-scroll-in {
    animation: atl-scroll-in linear both;
    animation-timeline: view();
    animation-range: entry 6% cover 42%;
  }
  .atl-scroll-fade {
    animation: atl-scroll-fade linear both;
    animation-timeline: view();
    animation-range: entry 12% cover 46%;
  }
  .atl-spot {
    animation: atl-spot linear both;
    animation-timeline: view();
    animation-range: cover 12% cover 86%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .atl-packet,
  .atl-ping,
  .atl-grid,
  .atl-blink,
  .atl-ticker,
  .atl-scroll-in,
  .atl-scroll-fade,
  .atl-spot {
    animation: none !important;
  }
}
`;
