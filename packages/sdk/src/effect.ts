/**
 * Reversible effects: every registration a plugin performs returns a disposer,
 * and the kernel holds those disposers so deactivation unwinds them in reverse
 * order. This is the "temporal composability" seam: a plugin unloads without
 * leaving residue behind, without relying on the plugin author to remember a
 * mirror-image cleanup step.
 */

/** A function that reverses one registration performed by a plugin. */
export type Disposable = () => void;

/** A registration form that may not need to reverse anything. */
export type EffectResult = void | Disposable;

/**
 * Runs `fn`, treating either a returned disposer or any disposer handed to the
 * supplied `collect` callback as part of the same effect. Returns a single
 * disposer that unwinds everything collected, most recent first.
 */
export function runEffect(
  fn: (collect: (disposable: Disposable) => void) => EffectResult,
): Disposable {
  const disposables: Disposable[] = [];
  const collect = (disposable: Disposable): void => {
    disposables.push(disposable);
  };
  const produced = fn(collect);
  if (typeof produced === 'function') {
    disposables.push(produced);
  }
  return disposeAll(disposables);
}

/** Dispose a list in reverse (LIFO) order, isolating individual failures. */
export function disposeAll(disposables: Disposable[]): Disposable {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (let i = disposables.length - 1; i >= 0; i -= 1) {
      try {
        disposables[i]?.();
      } catch (err) {
        console.error('[effect] disposer failed', err);
      }
    }
    disposables.length = 0;
  };
}

/**
 * An ordered collection of disposers. Registrations push onto it; a single
 * `dispose()` unwinds the whole list in reverse order. Safe to dispose twice.
 */
export class DisposableList {
  private readonly disposables: Disposable[] = [];
  private disposed = false;

  /** Track one more disposable. Returns an untrack function for early removal. */
  push(disposable: Disposable): Disposable {
    if (this.disposed) {
      disposable();
      return () => undefined;
    }
    this.disposables.push(disposable);
    return () => {
      const index = this.disposables.lastIndexOf(disposable);
      if (index >= 0) {
        this.disposables.splice(index, 1);
      }
    };
  }

  /** Whether nothing is currently tracked. */
  get size(): number {
    return this.disposables.length;
  }

  /** Unwind every tracked disposable in reverse order. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = this.disposables.length - 1; i >= 0; i -= 1) {
      try {
        this.disposables[i]?.();
      } catch (err) {
        console.error('[effect] disposer failed', err);
      }
    }
    this.disposables.length = 0;
  }
}
