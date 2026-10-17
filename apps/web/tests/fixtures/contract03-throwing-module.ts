/**
 * Test fixture for contract 03 §5.1/§5.2 (the `try/catch import → null` boundary).
 *
 * It reproduces the exact shape the contract describes: a module whose *load*
 * performs a process-level / top-level side effect and THEN throws. The
 * `try/catch` around the import can turn the failure into `null`, but it cannot
 * roll the side effect back — proving the boundary is "load downgrade", not a
 * sandbox.
 *
 * The side effect is idempotent and leaves no residue beyond a single global, so
 * the test is deterministic and safe to run in the shared vitest process.
 */
export {};

(globalThis as Record<string, unknown>)['__CONTRACT03_TOP_LEVEL_SIDE_EFFECT__'] =
  ((globalThis as Record<string, unknown>)['__CONTRACT03_TOP_LEVEL_SIDE_EFFECT__'] as number ?? 0) + 1;

throw new Error('contract03-fixture: module top-level threw after its side effect');
