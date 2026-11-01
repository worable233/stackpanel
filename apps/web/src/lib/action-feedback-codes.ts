/**
 * URL 反馈通道的**错误码契约**（`?action=…&error=…` / `?success=…`）。
 *
 * 历史包袱：这条通道原本直接往 query 里塞**已经本地化的人类文案**
 * （`?success=已保存`）。于是任何人构造
 * `https://站点/admin?action=market.install&success=<任意文本>` 就能让站内
 * toast 显示任意内容——可以用来伪造「安装成功」「请在此处重新输入管理员密码」
 * 之类的钓鱼提示，也能把攻击者的话术渲染成看起来来自站点本身的提示。
 * 另外 URL 只能安全承载有限的字符集，实测截图里出现过 `??????`。
 *
 * 现在的规则：
 *
 * 1. **URL 只带 code**，界面拥有文案（ADR-0012 / ADR-0016）；
 * 2. code 必须命中词表（`action.feedback.*`），未命中 → 通用文案 + 小字 code，
 *    **永不渲染 URL 原文**；
 * 3. 插件若要传动态文本（计数、上游原文），走**一次性 flash**
 *    （`lib/action-flash.ts`：服务端写加密 cookie，URL 只带随机 token）。
 *
 * 这个文件必须同时能在服务端（写 URL）和浏览器（读 URL）里用，所以只依赖
 * i18n 核心，不依赖 `server-only`。
 */

import { lookupTranslation, translate } from '@/i18n/core';
import type { Locale } from '@/i18n/config';

/** URL 里允许出现的 code 形态：小写字母/数字/点/下划线/连字符，最长 64。 */
const CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** 一次性 flash 的 token：`crypto.randomUUID()` 的十六进制/短横线形态。 */
const FLASH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** URL 里看起来像 code（而不是一句人话）吗？ */
export function isFeedbackCode(value: string | null | undefined): boolean {
  return typeof value === 'string' && CODE_PATTERN.test(value);
}

/** 一次性 flash 的 token 形态校验（真正的解密与过期在 `action-flash`）。 */
export function isFlashToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && FLASH_TOKEN_PATTERN.test(value);
}

/**
 * 内核认得的反馈 code。
 *
 * 这是**白名单**而不是「有词条就渲染」：插件可能声明 `successFeedback.messageKey`
 * 指向自己的 catalog，但 URL 通道只用于内核自己的 server action（见
 * `docs/design/feedback-ux-handoff.md` §4.1），所以这里的表就是完整集合。
 * 新增一条时同步补 `action.feedback.*` 四语文案。
 */
export const ACTION_FEEDBACK_CODES = [
  'failed',
  'succeeded',
  'upstreamSyncFailed',
  'upstreamSyncSucceeded',
  'upstreamCreateFailed',
  'upstreamDeleteFailed',
] as const;

export type ActionFeedbackCode = (typeof ACTION_FEEDBACK_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set(ACTION_FEEDBACK_CODES);

/** 一个可渲染的反馈：文案由本地词表给出，code 只作为排障小字。 */
export interface ActionFeedback {
  /** 是否命中词表。false 时界面显示通用文案 + 小字 code。 */
  known: boolean;
  /** 本地化文案。 */
  text: string;
  /** 原始 code（可能是未登记的 code，仍要能显示出来便于排查）。 */
  code: string;
}

/**
 * 把 URL 里的 `error` / `success` 解析成可渲染的反馈。
 *
 * 只有合法 code 才会被翻译；任何**看起来像一句话**的值（历史链接、手工构造、
 * 插件旧版 `?success=已保存`）一律当作未知 code 处理：显示通用文案，把原值
 * 作为小字附在后面，绝不整句渲染。这样历史链接不会变成空白，攻击面也消失了。
 */
export function resolveActionFeedback(
  locale: Locale,
  kind: 'error' | 'success',
  raw: string | null | undefined,
): ActionFeedback | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const namespace = 'action.feedback';
  const genericKey = kind === 'error' ? `${namespace}.failed` : `${namespace}.succeeded`;
  const generic = translate(locale, genericKey);
  const value: string = raw;
  if (!isFeedbackCode(value)) {
    // 不是 code：不翻译、不渲染原文，只留一句通用文案。原文进控制台供排障。
    if (typeof console !== 'undefined') {
      console.warn(`[action-feedback] ignored non-code ${kind} parameter`, value.slice(0, 120));
    }
    return { known: false, text: generic, code: 'invalid' };
  }
  const localized = lookupTranslation(locale, `${namespace}.${value}`);
  if (localized !== undefined && CODE_SET.has(value)) {
    return { known: true, text: localized, code: value };
  }
  return { known: false, text: generic, code: value };
}

/**
 * 由 action id 推出默认反馈 code（内核的 server action 目前都只有「成功/失败」）。
 *
 * 保留这个映射是为了让标题继续区分 zjmf 同步/新增/删除这类操作；未知 action
 * 落到通用文案（与改造前一致）。
 */
export function feedbackCodeForAction(actionId: string | null): ActionFeedbackCode {
  switch (actionId) {
    case 'zjmf-upstream.sync':
      return 'upstreamSyncFailed';
    case 'zjmf-upstream.create':
      return 'upstreamCreateFailed';
    case 'zjmf-upstream.delete':
      return 'upstreamDeleteFailed';
    default:
      return 'failed';
  }
}

export function successCodeForAction(actionId: string | null): ActionFeedbackCode {
  return actionId === 'zjmf-upstream.sync' ? 'upstreamSyncSucceeded' : 'succeeded';
}
