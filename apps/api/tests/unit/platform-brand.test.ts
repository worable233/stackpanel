import { describe, expect, it } from 'vitest';
import { BrandError, detectContentType, validateBrandFile } from '../../src/lib/platform-brand.ts';

/**
 * 品牌图标上传（logo / favicon）。
 *
 * 这组断言全部来自一次真实故障：运维上传一个标准 64×64 `.ico`，后台回
 * 415「logo 仅支持图片文件」—— 一个既没说支持什么、也把真正的图片判成
 * 非图片的提示。
 */
describe('platform brand upload', () => {
  /** Minimal valid ICO: reserved=0, type=1, count=1. Bytes after the header do not matter here. */
  const ico = Buffer.from('00000100010040400000010020002804000016000000', 'hex');

  it('accepts .ico — the format a favicon usually is', () => {
    expect(validateBrandFile('favicon', 'favicon.ico', ico)).toBe('.ico');
    expect(validateBrandFile('logo', 'logo.ICO', ico)).toBe('.ico');
  });

  it('still accepts the original formats', () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    for (const name of ['a.svg', 'a.png', 'a.jpg', 'a.jpeg', 'a.webp', 'a.gif']) {
      expect(validateBrandFile('logo', name, png)).toBe(name.slice(1));
    }
  });

  it('names the real formats when rejecting, instead of saying 仅支持图片文件', () => {
    // `.ico` *is* an image, so the old wording was both useless and wrong.
    let caught: unknown;
    try {
      validateBrandFile('logo', 'logo.bmp', ico);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BrandError);
    const error = caught as BrandError;
    expect(error.status).toBe(415);
    expect(error.message).toContain('ico');
    expect(error.message).toContain('svg');
    expect(error.message).not.toBe('logo 仅支持图片文件');
  });

  it('keeps the 1MB ceiling for ico too', () => {
    const huge = Buffer.alloc(1024 * 1024 + 1, 0);
    huge.write('00000100', 0, 'hex');
    let caught: unknown;
    try {
      validateBrandFile('favicon', 'favicon.ico', huge);
    } catch (error) {
      caught = error;
    }
    expect((caught as BrandError).status).toBe(413);
  });

  it('reports image/x-icon so S3 and the browser both get a renderable type', () => {
    // The old detector fell through to `application/octet-stream`, which the
    // object store faithfully echoed and some browsers refuse to render.
    expect(detectContentType(ico)).toBe('image/x-icon');
    expect(detectContentType(Buffer.from('89504e470d0a1a0a', 'hex'))).toBe('image/png');
    expect(detectContentType(Buffer.from('<'.charCodeAt(0).toString(16) + '3f786d6c', 'hex'))).toBe(
      'image/svg+xml',
    );
    expect(detectContentType(Buffer.from('474946383961', 'hex'))).toBe('image/gif');
    expect(detectContentType(Buffer.from('ffd8ffe000104a46', 'hex'))).toBe('image/jpeg');
    expect(detectContentType(Buffer.from('524946462400000057454250', 'hex'))).toBe('image/webp');
  });

  it('does not mistake an unknown container for an icon', () => {
    // ICO magic is reserved=0 + type=1. `00000100` is only the first half; the
    // check must not fire on a 4-byte prefix of something else.
    expect(detectContentType(Buffer.from('00000101', 'hex'))).toBe('application/octet-stream');
    expect(detectContentType(Buffer.from('00000000', 'hex'))).toBe('application/octet-stream');
  });
});
