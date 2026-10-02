/**
 * Upload policy: which detected media types are accepted and how large they may
 * be (ADR-0014 §3). Policy is intentionally a static kernel table, not plugin
 * config: an upload surface that can be widened by a plugin is an attack
 * surface. The env-tunable ceiling lives in `config/env.ts`.
 */
import type { SniffedMime } from './mime.ts';

export interface MediaPolicy {
  /** Confine the detected kind (image pipeline only runs for `image`). */
  allowedKinds: ReadonlySet<SniffedMime['kind']>;
  /** Hard ceiling per object, in bytes. */
  maxBytes: number;
  /** Soft ceiling above which an image is downscaled on ingest. */
  imageMaxDimension: number;
}

export const DEFAULT_MEDIA_POLICY: MediaPolicy = {
  allowedKinds: new Set(['image', 'document', 'archive']),
  maxBytes: 25 * 1024 * 1024,
  imageMaxDimension: 4096,
};

export type UploadRejection =
  | { code: 'media.unsupported_type'; status: 415; detail: string }
  | { code: 'media.too_large'; status: 413; detail: string }
  | { code: 'media.empty'; status: 400; detail: string };

/** Validate a detected upload against the policy. Returns null when accepted. */
export function checkUpload(
  sniffed: SniffedMime | null,
  byteLength: number,
  policy: MediaPolicy = DEFAULT_MEDIA_POLICY,
): UploadRejection | null {
  if (byteLength === 0) {
    return { code: 'media.empty', status: 400, detail: '文件为空' };
  }
  if (byteLength > policy.maxBytes) {
    return {
      code: 'media.too_large',
      status: 413,
      detail: `文件超过 ${Math.floor(policy.maxBytes / (1024 * 1024))}MB 上限`,
    };
  }
  if (!sniffed) {
    return { code: 'media.unsupported_type', status: 415, detail: '无法识别的文件类型' };
  }
  if (!policy.allowedKinds.has(sniffed.kind)) {
    return {
      code: 'media.unsupported_type',
      status: 415,
      detail: `不支持的文件类型：${sniffed.mime}`,
    };
  }
  return null;
}
