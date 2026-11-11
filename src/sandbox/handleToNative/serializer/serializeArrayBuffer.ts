import type { QuickJSAsyncContext, QuickJSContext, QuickJSHandle, Scope } from 'quickjs-emscripten-core'
import type { Serializer } from '../../../types/Serializer.js'
import type { SerializeState } from '../../../types/SerializeState.js'
import { call } from '../../helper.js'
import { chargeBudget, createSerializeBudget } from '../serializeBudget.js'

export const serializeArrayBuffer: Serializer = (
	ctx: QuickJSContext | QuickJSAsyncContext,
	handle: QuickJSHandle,
	_rootScope?: Scope,
	state?: SerializeState,
) => {
	// Dispatch is by guest-controlled `constructor.name`; make sure this really is an
	// ArrayBuffer before asking QuickJS for its bytes (which would leave a pending exception in
	// the guest for look-alikes). A look-alike falls through to generic object serialization.
	const byteLength = call(
		ctx,
		'internal/serializer/isArrayBuffer.js',
		`(b) => {
			try {
				return Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get.call(b)
			} catch {
				return -1
			}
		}`,
		undefined,
		handle,
	).consume(r => ctx.dump(r))
	if (typeof byteLength !== 'number' || byteLength < 0) return undefined

	// Charge the bytes we are about to keep before copying them out of the guest.
	chargeBudget(ctx, state?.budget ?? createSerializeBudget(ctx), byteLength)

	return ctx.getArrayBuffer(handle).consume(b => Uint8Array.from(b.value))
}
