/**
 * 品牌图标（logo / favicon）上传规则 —— Web 表单与内核的**唯一**真源。
 *
 * 为什么必须共用：两边各写一份就会出现「假成功」。
 *
 * 事故背景：`<input accept>` 与内核白名单是两套字符串。运营上传 `.ico`，
 * 前端 `accept` 把它静默丢掉（`<input type="file">` 对被 `accept` 排除的文件
 * 不报错，只是 `files` 里不出现），请求体里只剩 logo，内核老实返回 200，
 * 界面弹出「保存成功」—— 而 favicon 一次都没上传过。用户看到的是一句
 * 成功提示和一个 404 的图标。
 *
 * 规则：**客户端能选中的，服务端必须收；服务端会拒的，客户端必须先报错。**
 * 所以两边读同一份 `BRAND_IMAGE_EXTENSIONS`。
 */

/** 允许的扩展名（小写，带点）。内核据此写入，前端据此生成 `accept`。 */
export const BRAND_IMAGE_EXTENSIONS = [
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.ico',
] as const;

/** 扩展名 → 浏览器/对象存储使用的 MIME。 */
export const BRAND_IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

/** 上传体积上限（1 MiB）。两边都用它，避免「前端放行、后端 413」。 */
export const MAX_BRAND_FILE_BYTES = 1024 * 1024;

/**
 * `<input accept>` 的值。
 *
 * 同时列扩展名与 MIME：只看扩展名的平台不会把 `.ico` 归进 `image/*`，而只写
 * `image/*` 又会让用户挑到注定被拒的文件。两者并列才在各家文件选择器里都正确。
 */
export const BRAND_IMAGE_ACCEPT = [
  ...BRAND_IMAGE_EXTENSIONS,
  ...new Set(Object.values(BRAND_IMAGE_MIME_BY_EXTENSION)),
  // 同一个格式在 Windows 上的别名，文件选择器按它过滤。
  'image/vnd.microsoft.icon',
].join(',');

/** 人类可读的格式列表，用于错误文案（服务端英文原文 + 前端提示共用）。 */
export const BRAND_IMAGE_SUMMARY = BRAND_IMAGE_EXTENSIONS.map((ext) => ext.slice(1)).join('/');

/** 取小写扩展名（含点）；无扩展名时返回空串。 */
export function brandImageExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * 单个文件的拒绝原因；`null` 表示通过。
 *
 * 返回**结构化原因**而不是一个字符串：调用方需要把「格式不支持」和
 * 「文件太大」映射到不同的 code / 不同的提示语。
 */
export type BrandFileRejection = 'unsupported_type' | 'too_large' | 'empty';

export function rejectBrandFile(
  name: string,
  size: number,
): BrandFileRejection | null {
  if (!(BRAND_IMAGE_EXTENSIONS as readonly string[]).includes(brandImageExtension(name))) {
    return 'unsupported_type';
  }
  if (size <= 0) return 'empty';
  if (size > MAX_BRAND_FILE_BYTES) return 'too_large';
  return null;
}
