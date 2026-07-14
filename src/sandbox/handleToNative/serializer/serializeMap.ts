import type { QuickJSAsyncContext, QuickJSContext, QuickJSHandle, Scope } from 'quickjs-emscripten-core'
import type { SerializeState } from '../../../types/SerializeState.js'
import type { Serializer } from '../../../types/Serializer.js'
import { call } from '../../helper.js'
import { handleToNative } from '../handleToNative.js'

export const serializeMap: Serializer = (
	ctx: QuickJSContext | QuickJSAsyncContext,
	handle: QuickJSHandle,
	rootScope?: Scope,
	state?: SerializeState,
) => {
	const m = new Map()
	ctx
		.newFunction('', (key, value) => {
			const k = handleToNative(ctx, key, rootScope, state)
			const v = handleToNative(ctx, value, rootScope, state)
			m.set(k, v)
		})
		.consume(f => {
			call(
				ctx,
				'internal/serializer/serializeMap.js',
				`(m,fn) => {
            for(const [key,value] of m.entries())
              fn(key,value)
          }`,
				undefined,
				handle,
				f,
			).dispose()
		})
	return m
}
