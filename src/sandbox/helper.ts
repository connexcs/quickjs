import type { QuickJSAsyncContext, QuickJSContext, QuickJSHandle } from 'quickjs-emscripten-core'

/**
 * Marks an error as already carrying a deliberate, human-readable serialization message
 * (e.g. the depth-limit `RangeError` or a per-property failure). {@link call} lets such
 * errors propagate unchanged instead of re-wrapping them, so the specific message is what
 * ultimately bubbles up to the caller.
 */
export const SERIALIZE_ERROR = Symbol('quickjs.serializeError')

/**
 * Side-channel used to preserve a deliberate serialization error across the guest boundary.
 *
 * When a host callback (invoked from inside a guest `call`) throws, QuickJS captures it and
 * surfaces an opaque unwrap error on the host side — our original `Error` (and its
 * `SERIALIZE_ERROR` tag) is lost. To keep the descriptive error, the thrower stashes it on
 * the context under this symbol; {@link call} re-throws the stashed error instead of the
 * opaque one.
 */
const PENDING_SERIALIZE_ERROR = Symbol('quickjs.pendingSerializeError')

/**
 * Record a deliberate serialization error so it survives the guest boundary and reaches the
 * caller unchanged. See {@link PENDING_SERIALIZE_ERROR}.
 */
export const stashSerializeError = (ctx: object, error: unknown) => {
	;(ctx as any)[PENDING_SERIALIZE_ERROR] = error
}

/**
 * Discard any error stashed on the context. Used when a caller deliberately handles a
 * serialization failure (e.g. a type-specific serializer was dispatched by constructor name
 * but the value isn't really that type, so we fall back to generic serialization) and does
 * not want it re-surfaced by a later {@link call}.
 */
export const clearSerializeError = (ctx: object) => {
	delete (ctx as any)[PENDING_SERIALIZE_ERROR]
}

export const call = (
	ctx: QuickJSContext | QuickJSAsyncContext,
	fileName: string,
	code: string,
	that: QuickJSHandle | undefined,
	...args: QuickJSHandle[]
) => {
	const fnHandle = ctx.unwrapResult(ctx.evalCode(code, fileName))
	try {
		const callHandle = ctx.unwrapResult(ctx.callFunction(fnHandle, that || ctx.undefined, ...args))
		fnHandle.dispose()
		return callHandle
	} catch (error) {
		// Do not log here — a library should propagate, not print. Logging the raw error
		// on the throw path floods consumer logs with runaway recursive stacks (and gets
		// logged again by every consumer that catches the rethrown error). The error we
		// re-throw carries everything a consumer needs via `cause`, and it must never be
		// swallowed — it always bubbles up to the caller.

		// If a deliberate, descriptive serialization error was stashed while running the
		// guest callback, surface that instead of the opaque unwrap error (the guest boundary
		// would otherwise have discarded it). Also honour the tag for errors that never
		// crossed the boundary.
		const pending = (ctx as any)[PENDING_SERIALIZE_ERROR]
		if (pending) {
			delete (ctx as any)[PENDING_SERIALIZE_ERROR]
			throw pending
		}
		if (error && (error as any)[SERIALIZE_ERROR]) throw error

		const underlying = (error as Error)?.message
		const e = new Error(`Serialization failed while executing "${fileName}"${underlying ? `: ${underlying}` : ''}`)
		e.name = 'SerializationError'
		e.cause = error
		throw e
	}
}
