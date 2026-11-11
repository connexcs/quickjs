import type { QuickJSAsyncContext, QuickJSContext, QuickJSHandle, Scope } from 'quickjs-emscripten-core'
import type { Serializer } from '../../../types/Serializer.js'
import { call } from '../../helper.js'

export const serializeArrayBuffer: Serializer = (
	ctx: QuickJSContext | QuickJSAsyncContext,
	handle: QuickJSHandle,
	_rootScope?: Scope,
) => {
	// Dispatch is by guest-controlled `constructor.name`; make sure this really is an
	// ArrayBuffer before asking QuickJS for its bytes (which would leave a pending exception in
	// the guest for look-alikes). A look-alike falls through to generic object serialization.
	const isArrayBuffer = call(
		ctx,
		'internal/serializer/isArrayBuffer.js',
		`(b) => {
			try {
				Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get.call(b)
				return true
			} catch {
				return false
			}
		}`,
		undefined,
		handle,
	).consume(r => ctx.dump(r))
	if (isArrayBuffer !== true) return undefined

	return ctx.getArrayBuffer(handle).consume(b => Uint8Array.from(b.value))
}
