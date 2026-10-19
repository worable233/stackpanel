/**
 * 判断当前模块是否作为 CLI 主入口被执行。
 *
 * 不能直接比较 `import.meta.url === \`file://${process.argv[1]}\``：Node 会把主模块
 * 解析成 **realpath**，而 `argv[1]` 保留调用时的路径。只要安装路径经过符号链接
 * （macOS 的 `/tmp` → `/private/tmp`、`/opt/stackpanel` 之类的软链），比较就为假，
 * 结果是进程静默退出 0 且什么都不做——对升级执行者是最危险的失败模式。
 *
 * 这里对两侧都取 realpath 后再比较；`argv[1]` 不可解析时退回字面比较。
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isEntrypoint(
  argv1: string | undefined,
  moduleUrl: string = import.meta.url,
): boolean {
  if (!argv1) return false;
  const self = fileURLToPath(moduleUrl);
  if (self === argv1) return true;
  try {
    return realpathSync(self) === realpathSync(argv1);
  } catch {
    return false;
  }
}
