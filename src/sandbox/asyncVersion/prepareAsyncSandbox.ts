import type { IFs } from 'memfs'
import type { QuickJSAsyncContext, Scope } from 'quickjs-emscripten-core'
import type { SandboxBaseOptions } from '../../types/SandboxOptions.js'
import { setSerializeLimit } from '../handleToNative/serializeBudget.js'
import { provideConsole } from '../provide/provideConsole.js'
import { provideCrypto } from '../provide/provideCrypto.js'
import { provideEnv } from '../provide/provideEnv.js'
import { provideFs } from '../provide/provideFs.js'
import { provideHttp } from '../provide/provideHttp.js'

export const prepareAsyncSandbox = (
	ctx: QuickJSAsyncContext,
	scope: Scope,
	sandboxOptions: SandboxBaseOptions,
	fs: IFs,
) => {
	// Must run first: every guest→host conversion below (and later) reads this limit.
	setSerializeLimit(ctx, sandboxOptions.maxSerializedSize)
	provideFs(ctx, scope, sandboxOptions, fs)
	provideConsole(ctx, scope, sandboxOptions)
	provideEnv(ctx, scope, sandboxOptions)
	provideHttp(ctx, scope, sandboxOptions, { fs: sandboxOptions.allowFs ? fs : undefined })
	provideCrypto(ctx, scope, sandboxOptions)
}
