import {
	type JSPromiseState,
	type QuickJSAsyncContext,
	type QuickJSContext,
	type QuickJSHandle,
	Scope,
} from 'quickjs-emscripten-core'
import type { SerializeState } from '../../types/SerializeState.js'
import { getHandle } from '../expose/expose.js'
import { call, clearSerializeError, SERIALIZE_ERROR, stashSerializeError } from '../helper.js'
import {
	ARRAY_SLOT_COST,
	chargeBudget,
	createSerializeBudget,
	NODE_COST,
	type SerializeBudget,
	STRING_CHAR_COST,
} from './serializeBudget.js'
import { getSerializer } from './serializer/index.js'

/**
 * Maximum object nesting depth we will serialize before giving up. Acts as a backstop
 * against pathologically deep graphs and any cycle the visited-`Set` fails to catch.
 */
const MAX_DEPTH = 200

/**
 * Serializer-handled constructors that can themselves contain arbitrary (and possibly
 * cyclic) values, so they participate in visited-tracking. Leaf value-types handled by a
 * serializer (Date, Buffer, ArrayBuffer, URL, …) are intentionally excluded — they can't
 * form a cycle, and excluding them means a shared instance still serializes each time.
 */
const CONTAINER_CONSTRUCTORS = new Set(['Map', 'Set'])

/**
 * Serialize data from guest to host.
 *
 * Cyclic / self-referential guest graphs are handled gracefully: a repeated reference
 * is replaced with a `'[Circular]'` marker rather than recursing forever. Genuine
 * failures (depth overflow, size budget, guest-call errors) throw with a descriptive message
 * so they bubble up to the caller instead of failing silently.
 *
 * The size of the produced host value is bounded by a {@link SerializeBudget} (option
 * `maxSerializedSize`); exceeding it throws a `RangeError`.
 *
 * @param ctx The sandbox context
 * @param handle The QuickJS handle to serialize
 * @param rootScope Scope owning long-lived handles created during serialization
 * @param state Internal recursion state (visited set + depth + budget); created automatically
 *   on the top-level call — callers should not pass this.
 * @param budget Optional size budget for a top-level call, so several conversions (e.g. all
 *   arguments of one guest→host call) share one budget. Ignored when `state` is passed.
 * @returns
 */
export const handleToNative = (
	ctx: QuickJSContext | QuickJSAsyncContext,
	handle: QuickJSHandle,
	rootScope?: Scope,
	state?: SerializeState,
	budget?: SerializeBudget,
) => {
	if (state) {
		try {
			return convert(ctx, handle, rootScope, state, budget)
		} catch (error) {
			// Nested conversions run inside guest callbacks, so a deliberate error must be re-stashed
			// at every boundary it crosses (an enclosing `call` consumes the stash when it rethrows).
			if (error && (error as any)[SERIALIZE_ERROR]) stashSerializeError(ctx, error)
			throw error
		}
	}
	try {
		return convert(ctx, handle, rootScope, state, budget)
	} catch (error) {
		// The outermost conversion is done: nothing will consume a stashed error any more, so drop
		// it instead of letting a later, unrelated `call` failure report it.
		clearSerializeError(ctx)
		throw error
	}
}

/** Length of a guest string primitive, read without copying its contents to the host. */
const stringLength = (ctx: QuickJSContext | QuickJSAsyncContext, handle: QuickJSHandle): number =>
	ctx.getProp(handle, 'length').consume(l => ctx.getNumber(l))

const convert = (
	ctx: QuickJSContext | QuickJSAsyncContext,
	handle: QuickJSHandle,
	rootScope: Scope | undefined,
	state: SerializeState | undefined,
	budget: SerializeBudget | undefined,
): any => {
	const b = state?.budget ?? budget ?? createSerializeBudget(ctx)
	chargeBudget(ctx, b, NODE_COST)

	const ty = ctx.typeof(handle)

	if (ty === 'undefined') {
		return undefined
	}
	if (ty === 'null') {
		return null
	}
	if (ty === 'string') {
		// Charge from the length before copying the characters out of the guest, so an
		// over-budget string is never materialised on the host.
		chargeBudget(ctx, b, STRING_CHAR_COST * stringLength(ctx, handle))
		return ctx.dump(handle) as string
	}
	if (ty === 'number' || ty === 'boolean' || ty === 'bigint') {
		return ctx.dump(handle)
	}

	if (ty === 'symbol') {
		const descriptionHandle = ctx.getProp(handle, 'description')
		try {
			return Symbol(ctx.getString(descriptionHandle))
		} finally {
			descriptionHandle.dispose()
		}
	}

	const asPromiseState: JSPromiseState & { notAPromise?: boolean } = ctx.getPromiseState(handle)

	if (asPromiseState.type && !asPromiseState.notAPromise) {
		// A settled snapshot owns its value/error handle. The non-promise branch
		// borrows the input handle instead, so only dispose real snapshots.
		if (asPromiseState.type === 'fulfilled') asPromiseState.value.dispose()
		if (asPromiseState.type === 'rejected') asPromiseState.error.dispose()
		const hostPromise = ctx.resolvePromise(handle).then(val => {
			// The guest promise may settle long after the call that produced it has returned. By
			// then the context may be gone, in which case the settlement handles cannot be used:
			// reject with an ordinary error instead of letting an internal QuickJSUseAfterFree
			// surface.
			if (!ctx.alive) {
				throw new Error('The sandbox was disposed before the guest promise settled')
			}
			// `rootScope` is typically the per-call scope of a host function and is disposed as soon
			// as that function returns. A host function that awaits the promise later still deserves
			// its value, so convert into a short-lived scope of our own when the original is gone.
			const fallbackScope = rootScope && !rootScope.alive ? new Scope() : undefined
			try {
				const scope = fallbackScope ?? rootScope
				// Settlement happens outside the walk that found the promise, so it is converted as a
				// conversion of its own: the old recursion state (ancestor path, possibly owned by a
				// disposed scope) no longer applies. Only the size budget is carried over, so values
				// delivered through promises count against the conversion they belong to.
				if (val.error) throw handleToNative(ctx, val.error, scope, undefined, b)
				return handleToNative(ctx, val.value, scope, undefined, b)
			} finally {
				try {
					fallbackScope?.dispose()
				} finally {
					val.dispose()
				}
			}
		})
		// A guest can hand a promise to any host function, and that function is free to ignore it.
		// If the promise then rejects, nobody is left to handle it and the host process would see
		// an unhandled rejection. Mark it handled here; callers that DO await the returned promise
		// (it is returned as-is) still observe the rejection normally.
		hostPromise.catch(() => {})
		return hostPromise
	}

	// Everything below serializes an object / function — the only shapes that can be
	// cyclic. Lazily create the recursion state (a guest-side visited `Set` + depth) on
	// the first such call and thread it into every recursive descent. `===` object
	// identity is reliable inside the guest, so we ask the guest whether it has already
	// seen this exact object; a repeat resolves to `'[Circular]'` instead of recursing
	// forever. `quickjs-emscripten-core` exposes no host-side handle-equality primitive,
	// which is why the check lives guest-side. The Set is owned by `rootScope` so it is
	// disposed with the rest of the serialization's long-lived handles.
	const s: SerializeState = state ?? {
		seen: rootScope
			? rootScope.manage(call(ctx, 'internal/serializer/newSeen.js', '() => new Set()', undefined))
			: undefined,
		depth: 0,
		budget: b,
	}

	const childState: SerializeState = { seen: s.seen, depth: s.depth + 1, budget: b }

	if (s.depth > MAX_DEPTH) {
		const e = new RangeError(
			`Failed to serialize ${ty}: maximum object depth (${MAX_DEPTH}) exceeded — the guest value graph is too deeply nested or contains an undetected cycle`,
		)
		;(e as any)[SERIALIZE_ERROR] = true
		// Stash so the message survives if this throw happens inside a guest callback.
		stashSerializeError(ctx, e)
		throw e
	}

	// `seen` tracks the objects on the *current ancestor path* (not every object ever
	// visited), so only genuine cycles — an object that reappears while it is still being
	// serialized — are flagged; a shared but acyclic subtree that appears in two sibling
	// branches serializes fully in each. `markSeen` adds the object and returns true if it
	// was already on the path (a cycle); `unmarkSeen` removes it once its subtree is done.
	// Identity is checked guest-side because `quickjs-emscripten-core` exposes no host-side
	// handle-equality primitive. Without a `seen` Set (no root scope) we fall back to the
	// depth guard above.
	const markSeen = (h: QuickJSHandle): boolean =>
		s.seen
			? (call(
					ctx,
					'internal/serializer/markSeen.js',
					'(o, seen) => { if (seen.has(o)) return true; seen.add(o); return false }',
					undefined,
					h,
					s.seen,
				).consume(r => ctx.dump(r)) as boolean)
			: false

	const unmarkSeen = (h: QuickJSHandle): void => {
		if (!s.seen) return
		call(ctx, 'internal/serializer/unmarkSeen.js', '(o, seen) => { seen.delete(o) }', undefined, h, s.seen).dispose()
	}

	// biome-ignore lint/complexity/noBannedTypes: ok here
	const setProperties = (obj: Object | Function, h: QuickJSHandle, isFunction = false) => {
		ctx
			.newFunction('', (key, value) => {
				// A string key is not a node of its own (the property's value is, and carries the
				// per-property `NODE_COST`), so only its characters are charged.
				let keyName: unknown
				if (ctx.typeof(key) === 'string') {
					chargeBudget(ctx, b, STRING_CHAR_COST * stringLength(ctx, key))
					keyName = ctx.dump(key) as string
				} else {
					keyName = handleToNative(ctx, key, rootScope, childState)
				}
				if (typeof keyName !== 'string' && typeof keyName !== 'number' && typeof keyName !== 'symbol') return

				const desc = (
					[
						['value', true],
						['get', true],
						['set', true],
						['configurable', false],
						['enumerable', false],
						['writable', false],
					] as const
				).reduce<PropertyDescriptor>((desc, [key, unmarshable]) => {
					const h = ctx.getProp(value, key)
					let t = 'unknown'

					try {
						t = ctx.typeof(h)
						if (t === 'undefined') return desc
						if (!unmarshable && t === 'boolean') {
							desc[key] = ctx.dump(h)
							return desc
						}

						desc[key] = handleToNative(ctx, h, rootScope, childState)
					} catch (error) {
						// Re-throw (never swallow). Errors already carrying a deliberate,
						// descriptive message (e.g. the depth-limit RangeError) pass through
						// untouched; anything else is wrapped with context about which property
						// failed, so the error that bubbles up identifies the culprit instead of
						// being an opaque low-level failure.
						if (error && (error as any)[SERIALIZE_ERROR]) {
							// Re-stash on the way up: this rethrow crosses the guest boundary of the
							// enclosing `call`, which would otherwise discard the descriptive error.
							stashSerializeError(ctx, error)
							throw error
						}
						const cause = (error as Error)?.message ?? String(error)
						const e = new Error(`Failed to serialize property "${String(keyName)}" (${t}): ${cause}`)
						;(e as any)[SERIALIZE_ERROR] = true
						e.cause = error
						// Stash so the message survives the guest boundary this callback runs behind.
						stashSerializeError(ctx, e)
						throw e
					} finally {
						h.dispose()
					}

					return desc
				}, {})

				// A guest array can declare a huge `length` without any elements (`new Array(2 ** 32 - 1)`);
				// defining it on the host array would be cheap for the guest and costly for the host.
				if (Array.isArray(obj) && keyName === 'length' && typeof desc.value === 'number') {
					chargeBudget(ctx, b, ARRAY_SLOT_COST * desc.value)
				}

				Object.defineProperty(obj, keyName, desc)
			})
			.consume(f => {
				try {
					call(
						ctx,
						'internal/serializer/setProperties.js',
						// A function's own 'prototype' (and the legacy 'caller'/'arguments') are
						// implementation artifacts, not data. Serializing 'prototype' walks the
						// prototype chain into the guest's global built-ins (Map.prototype,
						// Date.prototype, …), which report a matching constructor name but aren't
						// instances — mis-firing every type serializer. Skip them so functions
						// serialize to just their real, assigned properties. The `isFunction` flag is
						// baked into the code because it is a static, per-call boolean.
						`(o, fn) => {
							const skip = ${isFunction ? "new Set(['prototype', 'caller', 'arguments'])" : 'undefined'};
							const descs = Object.getOwnPropertyDescriptors(o);
							Object.entries(descs).forEach(([k, v]) => { if (!skip || !skip.has(k)) fn(k, v); });
							Object.getOwnPropertySymbols(descs).forEach(k => fn(k, descs[k]));
						}`,
						undefined,
						h,
						f,
					).dispose()
				} finally {
					// This object's subtree is done — remove it from the current path so a later,
					// non-cyclic sibling reference to the same object still serializes fully.
					unmarkSeen(h)
				}
			})
	}

	if (ty === 'function') {
		if (!rootScope) throw new Error('Missing root scope')
		if (markSeen(handle)) return '[Circular]'
		const cpHandle = rootScope.manage(handle.dup())

		const f = function (this: any, ...args: any[]) {
			// Nothing may touch the context before this check. The handle is owned by `rootScope`
			// (often a per-call scope) and dies with it, but the host may keep the wrapper and invoke
			// it later, e.g. an async callback of a host library or a getter read after the sandbox
			// finished. Calling into a disposed handle throws QuickJSUseAfterFree from inside that
			// library's own machinery, which a guest must not be able to trigger. A late call is
			// simply dropped.
			if (!ctx.alive || !cpHandle.alive) return undefined

			const scope = new Scope()
			const thisHandle = getHandle(scope, ctx, '', this)
			const argHandles = args.map(a => getHandle(scope, ctx, '', a))

			if (new.target) {
				const instance = handleToNative(
					ctx,
					call(
						ctx,
						'internal/serializer/newClass.js',
						'(Cls, ...args) => new Cls(...args)',
						thisHandle,
						cpHandle,
						...argHandles,
					),
					rootScope,
				)
				Object.defineProperties(this, Object.getOwnPropertyDescriptors(instance))
				scope.dispose()
				return this
			}

			try {
				const resultHandle = scope.manage(ctx.unwrapResult(ctx.callFunction(cpHandle, thisHandle, ...argHandles)))
				const res = handleToNative(ctx, resultHandle, rootScope)
				return res
			} finally {
				scope.dispose()
			}
		}

		setProperties(f, handle, true)
		return f
	}

	if (ty === 'object') {
		const isNull = call(ctx, 'internal/serializer/isNull.js', 'a => a === null', undefined, handle).consume(r =>
			ctx.dump(r),
		)
		if (isNull) return null

		// Check for Error instances
		const errorType = call(
			ctx,
			'internal/serializer/detectErrorType.js',
			`(o) => {
				try {
					const tag = Object.prototype.toString.call(o)
					if (tag.startsWith('[object ') && tag.endsWith(']')) {
						const type = tag.slice(8, -1)
						if (type.endsWith('Error')) return type
					}
					if (typeof o?.name === 'string' && typeof o?.message === 'string') return 'Error'
				} catch {}
				return undefined
			}`,
			undefined,
			handle,
		).consume(r => ctx.dump(r))

		if (typeof errorType === 'string') {
			const errorSerializer = getSerializer(errorType)
			if (errorSerializer) {
				const ret = errorSerializer(ctx, handle, rootScope, childState)
				if (ret) {
					return ret
				}
			}

			const errorScope = new Scope()
			let message: string
			let stack: unknown
			try {
				const messageHandle = errorScope.manage(ctx.getProp(handle, 'message'))
				const stackHandle = errorScope.manage(ctx.getProp(handle, 'stack'))
				message = ctx.dump(messageHandle) ?? ''
				stack = ctx.dump(stackHandle)
			} finally {
				errorScope.dispose()
			}

			const e = new Error(message)
			e.name = errorType
			if (typeof stack === 'string') e.stack = stack

			return e
		}

		const isArray = call(ctx, 'internal/serializer/isArray.js', 'Array.isArray', undefined, handle).consume(r =>
			ctx.dump(r),
		)

		const obj: any = isArray ? [] : {}

		const constructorName = call(
			ctx,
			'internal/serializer/getConstructorName.js',
			`o => { try { return typeof o?.constructor?.name === 'string' ? o.constructor.name : undefined } catch { return undefined } }`,
			undefined,
			handle,
		).consume(r => ctx.dump(r))

		const serializer = getSerializer(constructorName)
		if (serializer) {
			// Container serializers (Map/Set) recurse into arbitrary element values and can
			// therefore be part of a cycle (e.g. `m.set('k', m)`), so mark them for the
			// duration of the walk before dispatching. Leaf value-types (Date, Buffer, URL, …)
			// can't contain a cycle, so they are left unmarked — a shared, non-cyclic instance
			// still serializes fully each time it appears rather than collapsing to
			// `'[Circular]'`.
			const isContainer = CONTAINER_CONSTRUCTORS.has(constructorName)
			if (isContainer && markSeen(handle)) return '[Circular]'
			try {
				const ret = serializer(ctx, handle, rootScope, childState)
				if (ret) {
					return ret
				}
			} catch (error) {
				// A budget failure is a deliberate, final error — never a "look-alike" signal.
				if (b.exceeded) {
					stashSerializeError(ctx, error)
					throw error
				}
				// The serializer is chosen by `constructor.name`, which is unreliable: a value can
				// *report* a matching constructor (e.g. `Date.prototype`, a function's `prototype`,
				// a class that `extends Map`, or a spoofed `constructor`) without being an instance
				// of that type, so the type-specific guest op throws ("Map object expected", "not a
				// Date object", …). Treat any such failure as "not really this type": drop the
				// stashed error and fall through to generic object serialization below rather than
				// failing the whole result. Genuine instances (real Map/Set/Date/…) don't fail
				// their own extraction, so this only ever rescues mis-dispatched look-alikes.
				clearSerializeError(ctx)
			} finally {
				// The container is off the current path once its walk (success or fallback) is done.
				if (isContainer) unmarkSeen(handle)
			}
		}

		// Generic object / array: break cycles before recursing into its properties.
		if (markSeen(handle)) return '[Circular]'

		setProperties(obj, handle)

		return obj
	}

	throw new TypeError(`Failed to serialize ${ty}`)
}
