import type { QuickJSAsyncContext, QuickJSContext, QuickJSHandle, Scope } from 'quickjs-emscripten-core'
import type { SerializeState } from '../../../types/SerializeState.js'
import type { Serializer } from '../../../types/Serializer.js'
import { call } from '../../helper.js'
import { handleToNative } from '../handleToNative.js'

export const serializeSet: Serializer = (
	ctx: QuickJSContext | QuickJSAsyncContext,
	handle: QuickJSHandle,
	rootScope?: Scope,
	state?: SerializeState,
) => {
	const s = new Set()
	ctx
		.newFunction('', value => {
			const v = handleToNative(ctx, value, rootScope, state)
			s.add(v)
		})
		.consume(f => {
			call(
				ctx,
				'internal/serializer/serializeSet.js',
				`(s,fn) => {
            s.forEach(fn)
          }`,
				undefined,
				handle,
				f,
			).dispose()
		})
	return s
}
