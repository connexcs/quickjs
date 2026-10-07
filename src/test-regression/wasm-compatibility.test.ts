import { describe, expect, it, spyOn } from 'bun:test'
import asyncVariant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import sync from '@jitl/quickjs-ng-wasmfile-release-sync'
import { loadAsyncQuickJs } from '../loadAsyncQuickJs.js'
import { loadQuickJs } from '../loadQuickJs.js'

for (const variant of [
	{ name: 'sync', variant: sync, load: loadQuickJs },
	{ name: 'async', variant: asyncVariant, load: loadAsyncQuickJs },
]) {
	describe(`WASM compatibility - ${variant.name}`, () => {
		it('accepts a matching variant and leaves the shared runtime usable', async () => {
			const { runSandboxed } = await variant.load(variant.variant as never)
			for (let i = 0; i < 3; i++) {
				expect(
					await runSandboxed(({ evalCode }) => evalCode('export default await env.value()'), {
						env: { value: async () => 123 },
					}),
				).toMatchObject({ ok: true, data: 123 })
			}
		})
		it('rejects a HostRef ABI before invoking its incompatible function signature', async () => {
			const candidate = {
				...variant.variant,
				importFFI: async () => {
					const FFI = await variant.variant.importFFI()
					return class extends FFI {
						QTS_NewHostRef = () => {
							throw new Error('must not be called')
						}
					}
				},
			}
			await expect(variant.load(candidate as never)).rejects.toThrow('requires a 0.31.x variant')
		})
		it('rejects silent callback failures even when arithmetic evaluation works', async () => {
			const candidate = {
				...variant.variant,
				importFFI: async () => {
					const FFI = await variant.variant.importFFI()
					return class extends FFI {
						constructor(...args: ConstructorParameters<typeof FFI>) {
							super(...args)
							const ffi = this as unknown as { QTS_NewFunction: (ctx: unknown, id: number, name: unknown) => unknown }
							const original = ffi.QTS_NewFunction
							ffi.QTS_NewFunction = (ctx, id, name) => original(ctx, id + 1, name)
						}
					}
				},
			}
			const consoleError = spyOn(console, 'error').mockImplementation(() => {})
			try {
				const { runSandboxed } = await variant.load(candidate as never)
				await expect(runSandboxed(({ evalCode }) => evalCode('export default 1+1'))).rejects.toThrow(
					'Incompatible QuickJS WASM variant',
				)
			} finally {
				consoleError.mockRestore()
			}
		})
	})
}
