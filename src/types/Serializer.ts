import type { QuickJSAsyncContext, QuickJSContext, QuickJSHandle, Scope } from 'quickjs-emscripten-core'
import type { SerializeState } from './SerializeState.js'

export type Serializer = (
	ctx: QuickJSContext | QuickJSAsyncContext,
	handle: QuickJSHandle,
	rootScope?: Scope,
	state?: SerializeState,
) => any
