import type { QuickJSAsyncContext, QuickJSContext } from 'quickjs-emscripten-core'
import { SERIALIZE_ERROR, stashSerializeError } from '../helper.js'

type Context = QuickJSContext | QuickJSAsyncContext

/**
 * Default maximum number of (estimated) bytes one guest→host conversion may produce.
 */
export const DEFAULT_MAX_SERIALIZED_SIZE = 16 * 1024 * 1024

/** Estimated host cost of every converted value / property key (object header, slot, …). */
export const NODE_COST = 64
/** Estimated host cost per string character (UTF-16). */
export const STRING_CHAR_COST = 2
/** Estimated host cost per array slot. */
export const ARRAY_SLOT_COST = 8

const limits = new WeakMap<object, number>()

/**
 * Configure the serialization limit of a context.
 * `undefined` selects the default, `0` (or any non-finite / negative number) disables the limit.
 */
export const setSerializeLimit = (ctx: Context, limit: number | undefined) => {
	if (limit === undefined) {
		limits.set(ctx, DEFAULT_MAX_SERIALIZED_SIZE)
	} else if (!Number.isFinite(limit) || limit <= 0) {
		limits.set(ctx, Number.POSITIVE_INFINITY)
	} else {
		limits.set(ctx, limit)
	}
}

export type SerializeBudget = {
	remaining: number
	limit: number
	exceeded: boolean
}

/**
 * Create a fresh budget for one conversion (one evalCode result, or one guest→host call).
 */
export const createSerializeBudget = (ctx: Context): SerializeBudget => {
	const limit = limits.get(ctx) ?? DEFAULT_MAX_SERIALIZED_SIZE
	return { remaining: limit, limit, exceeded: false }
}

/**
 * Subtract `bytes` from the budget; throws a tagged, stashed `RangeError` once it is exhausted
 * (and on every later charge, so a swallowed failure cannot be resumed).
 */
export const chargeBudget = (ctx: Context, budget: SerializeBudget, bytes: number) => {
	budget.remaining -= bytes
	if (budget.exceeded || budget.remaining < 0) {
		budget.exceeded = true
		const e = new RangeError(
			`Failed to serialize: the value passed from the sandbox exceeds the maximum serialized size (${budget.limit} bytes, option maxSerializedSize)`,
		)
		;(e as any)[SERIALIZE_ERROR] = true
		// Stash so the message survives if this throw happens inside a guest callback.
		stashSerializeError(ctx, e)
		throw e
	}
}
