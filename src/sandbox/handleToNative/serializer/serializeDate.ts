import type { QuickJSAsyncContext, QuickJSContext, QuickJSHandle, Scope } from 'quickjs-emscripten-core'
import type { SerializeState } from '../../../types/SerializeState.js'
import type { Serializer } from '../../../types/Serializer.js'
import { call } from '../../helper.js'
import { handleToNative } from '../handleToNative.js'

export const serializeDate: Serializer = (
	ctx: QuickJSContext | QuickJSAsyncContext,
	handle: QuickJSHandle,
	rootScope?: Scope,
	state?: SerializeState,
) => {
	const d = new Date()
	ctx
		.newFunction('', value => {
			const v = handleToNative(ctx, value, rootScope, state)
			d.setTime(v)
		})
		.consume(f => {
			call(
				ctx,
				'internal/serializer/serializeDate.js',
				`(d,fn) => {
                  fn(d.getTime())
                }`,
				undefined,
				handle,
				f,
			).dispose()
		})
	return d
}
