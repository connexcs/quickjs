import type { QuickJSHandle } from 'quickjs-emscripten-core'

/**
 * Internal state threaded through the recursive guest→host serialization
 * (see {@link handleToNative}).
 *
 * - `seen` is a guest-side `Set` handle used to detect already-visited objects,
 *   so cyclic / self-referential graphs resolve to a `'[Circular]'` marker instead
 *   of recursing forever. It is `undefined` only when serialization runs without a
 *   root scope to own it, in which case the depth backstop alone bounds recursion.
 * - `depth` is the current nesting depth, used as a backstop against pathological
 *   or undetected-cycle graphs.
 */
export type SerializeState = {
	seen: QuickJSHandle | undefined
	depth: number
}
