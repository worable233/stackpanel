/**
 * Stage 4 M2 — annotate a compiled client bundle's host-ABI adapter imports with
 * the exact named bindings it uses (`/api/frontend-abi/react?names=useState,useEffect`).
 *
 * Why: the adapter route runs on the server, and `react` resolves to the
 * `react-server` build there, whose named exports differ from the browser's React
 * (no `useState`, ...). The browser React namespace is also un-enumerable without
 * instantiating it, so the only reliable source of the right export names is what
 * the bundle actually imports. This scans `import ... from "/api/frontend-abi/<slot>"`
 * statements and rewrites each specifier to carry its `names`.
 *
 * `?names=` must list the **original** imported names. For
 * `import { useState as useState4 } from "..."` the adapter has to re-export
 * `useState` (it reads `ns["useState"]` off the host namespace); emitting the
 * local alias (`useState4`) makes the browser fail with
 * `does not provide an export named 'useState'`.
 *
 * Kept as a separate module (rather than inlined in `build-frontend.mjs`) so the
 * rewrite can be unit-tested without running the whole build.
 */

/**
 * @param {string} source Compiled bundle text.
 * @returns {string} Same bundle with every host-ABI adapter specifier annotated.
 */
export function annotateAdapterImportsSource(source) {
  // Collect per-slot named bindings from `import [Default, ]{ a, b as c } from "..."`.
  // `[^;]*?` lets the clause span lines (esbuild wraps long named lists) while
  // stopping at the statement terminator.
  const imports = new Map();
  const re = /^[ \t]*import\s+[^;]*?\{([^}]*)\}[^;]*?\bfrom\s*"(\/api\/frontend-abi\/[^"?]+)"/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    const names = m[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        // Keep the ORIGINAL name, not the local alias.
        const asMatch = /^(\S+)\s+as\s+\S+$/.exec(part);
        return asMatch ? asMatch[1] : part;
      })
      .filter((name) => name !== 'default' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name));
    const existing = imports.get(m[2]) ?? new Set();
    for (const name of names) existing.add(name);
    imports.set(m[2], existing);
  }
  if (imports.size === 0) return source;

  // Rewrite each adapter specifier (deduping when the same slot is imported twice).
  return source.replace(/(\/api\/frontend-abi\/[^"?]+)(\?names=[^"]*)?/g, (match, specifier) => {
    const names = imports.get(specifier);
    if (!names || names.size === 0) return specifier;
    return `${specifier}?names=${[...names].sort().join(',')}`;
  });
}
