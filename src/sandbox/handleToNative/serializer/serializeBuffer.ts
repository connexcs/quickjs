import type { QuickJSAsyncContext, QuickJSContext, QuickJSHandle, Scope } from 'quickjs-emscripten-core'
import type { Serializer } from '../../../types/Serializer.js'
import type { SerializeState } from '../../../types/SerializeState.js'
import { call } from '../../helper.js'

/**
 * Serializes a guest `Buffer` (or any Uint8Array-like view) to a host `Buffer`.
 *
 * Serializers are dispatched by the guest-controlled `constructor.name`, so nothing here may
 * trust what the guest reports. In particular the host must never size an allocation from a
 * guest-provided value (e.g. `{ length: 1e9 }`): the bytes are only ever copied out of a
 * genuine guest `ArrayBuffer`, and the view's `byteOffset` / `byteLength` are validated
 * against the real buffer length. Anything that is not genuinely binary yields `undefined`, so
 * the caller falls back to generic object serialization.
 */
export const serializeBuffer: Serializer = (
	ctx: QuickJSContext | QuickJSAsyncContext,
	handle: QuickJSHandle,
	_rootScope?: Scope,
	_state?: SerializeState,
) => {
	let b: Buffer | undefined
	ctx
		.newFunction('', (bufferHandle, offsetHandle, lengthHandle) => {
			if (ctx.typeof(offsetHandle) !== 'number' || ctx.typeof(lengthHandle) !== 'number') return
			const offset = ctx.getNumber(offsetHandle)
			const length = ctx.getNumber(lengthHandle)
			if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) return

			// `ctx.getArrayBuffer` copies the bytes out of the guest; the copy is bounded by the
			// guest's own memory limit, and it is released as soon as we have our slice.
			ctx.getArrayBuffer(bufferHandle).consume(copy => {
				const bytes = copy.value
				if (offset + length > bytes.length) return
				b = Buffer.from(bytes.subarray(offset, offset + length))
			})
		})
		.consume(f => {
			call(
				ctx,
				'internal/serializer/serializeBuffer.js',
				// The brand check (the real `ArrayBuffer.prototype.byteLength` getter throws for
				// anything that is not an ArrayBuffer) keeps look-alike objects away from the host
				// call; the host re-validates everything regardless.
				`(b, fn) => {
					const buffer = b.buffer
					Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get.call(buffer)
					fn(buffer, b.byteOffset, b.byteLength)
				}`,
				undefined,
				handle,
				f,
			).dispose()
		})
	return b
}
