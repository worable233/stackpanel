import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, '..', 'src');

/**
 * 守门：**服务端模块不得把「运行时解析出来的组件」当 props 传给客户端组件。**
 *
 * v0.1.1 首页 500 就是这个形态：`frontend-route.tsx`（服务端）把
 * `resolved.component`（运行时 import 的页面组件）传给 `PluginActionScope`
 * （`'use client'`），React 直接抛
 * 「Functions cannot be passed directly to Client Components」——**所有**公开页面
 * 都渲染失败，而构建、类型检查、单元测试全绿，因为没人真的渲染一次首页。
 *
 * 客户端边界只能接收可序列化的值，组件函数永远不是。所以这里静态扫描：
 * 文件没有 `'use client'` 时，若某个 JSX 属性名是组件类（component/page/layout/…）
 * 且取值不是字面量，而该标签来自 `'use client'` 模块，就判失败。
 */
/**
 * 只收「这个名字几乎必然是组件」的属性名。
 *
 * `page` / `pages` / `theme` 这类在企业后台里通常是**数据**（分页记录、主题名），
 * 把它们算进来只会制造噪音（`<SeoPageManager page={data.page} />` 是合法数据传参），
 * 而真正的事故形态是 `component={…}`。
 */
const COMPONENT_PROP = /^(component|Component|pageComponent|PageComponent|layout|Layout|renderer|Renderer)$/;

function walk(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
}

/** 模块文件是否以 `'use client'` 开头（指令必须在任何语句之前）。 */
function isClientModule(file: string): boolean {
  const source = readFileSync(file, 'utf8');
  return /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(source);
}

/** 解析 `@/…` 别名到仓库内文件（可能是 .ts/.tsx/index.*）。 */
function resolveAlias(specifier: string): string | null {
  if (!specifier.startsWith('@/')) return null;
  const base = path.join(webSrc, specifier.slice(2));
  for (const candidate of [
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, 'index.tsx'),
    path.join(base, 'index.ts'),
  ]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // 继续尝试下一个后缀。
    }
  }
  return null;
}

interface Violation {
  file: string;
  line: number;
  detail: string;
}

function scanServerModule(file: string): Violation[] {
  const source = readFileSync(file, 'utf8');
  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, scriptKind);

  // 本文件里「来自客户端模块」的本地名。
  const clientBindings = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const resolved = resolveAlias(statement.moduleSpecifier.text);
    if (!resolved || !isClientModule(resolved)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) clientBindings.set(clause.name.text, resolved);
    const named = clause.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        clientBindings.set(element.name.text, resolved);
      }
    }
  }
  if (clientBindings.size === 0) return [];

  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = node.tagName;
      const tag = ts.isIdentifier(tagName) ? tagName.text : null;
      if (tag && clientBindings.has(tag)) {
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute)) continue;
          const name = attribute.name.getText(sourceFile);
          if (!COMPONENT_PROP.test(name)) continue;
          const initializer = attribute.initializer;
          // 字面量（字符串/数字）跨边界是安全的；表达式不是。
          if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
            const expression = initializer.expression;
            const literal =
              ts.isStringLiteral(expression) ||
              ts.isNumericLiteral(expression) ||
              expression.kind === ts.SyntaxKind.TrueKeyword ||
              expression.kind === ts.SyntaxKind.FalseKeyword;
            if (!literal) {
              const { line } = sourceFile.getLineAndCharacterOfPosition(attribute.getStart());
              violations.push({
                file: path.relative(webSrc, file),
                line: line + 1,
                detail: `<${tag} ${name}={…}> 把非字面量传给了客户端组件（${clientBindings.get(tag)}）`,
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe('服务端渲染边界', () => {
  it('没有任何服务端模块把组件函数当 props 传给客户端组件', () => {
    const files: string[] = [];
    walk(webSrc, files);
    const violations = files
      .filter((file) => !isClientModule(file))
      .flatMap((file) => scanServerModule(file));
    expect(violations).toEqual([]);
  });

  it('公开页面路径仍用 createElement 在服务端渲染运行时组件', () => {
    const raw = readFileSync(path.join(webSrc, 'components/frontend-route.tsx'), 'utf8');
    // 注释里允许提到这个客户端包装层（解释为什么不能这么写），只看真正的代码。
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // 0.1.1 的写法（`<PluginActionScope component={…}/>`）会让每个公开页面 500。
    expect(source).toContain('createElement(resolved.component');
    expect(source).not.toMatch(/<PluginActionScope/);
    expect(source).not.toContain("from '@/lib/plugin-action-client'");
  });

  it('客户端 action 包装层不再导出会把组件跨边界的 PluginActionScope', () => {
    const source = readFileSync(path.join(webSrc, 'lib/plugin-action-client.ts'), 'utf8');
    expect(source).toContain('export function wrapPluginActions');
    expect(source).not.toContain('export function PluginActionScope');
  });
});
