import { describe, expect, it, spyOn } from 'bun:test'
import asyncVariant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import syncVariant from '@jitl/quickjs-ng-wasmfile-release-sync'
import {
	newQuickJSAsyncWASMModuleFromVariant,
	newQuickJSWASMModuleFromVariant,
	type QuickJSHandle,
	Scope,
} from 'quickjs-emscripten-core'
import { handleToNative } from '../sandbox/handleToNative/handleToNative.js'

for (const mode of ['sync', 'async'] as const) {
	describe(`${mode} - descriptor handle disposal`, () => {
		it.each([
			'plain',
			'mixed',
			'symbol failure',
			'message failure',
			'stack failure',
		])('releases property handles after %s conversions', async scenario => {
			const module = await (mode === 'sync'
				? newQuickJSWASMModuleFromVariant(syncVariant)
				: newQuickJSAsyncWASMModuleFromVariant(asyncVariant))
			// Context-owned teardown avoids upstream Asyncify #261; loader suites cover shared newRuntime().
			const ctx = module.newContext()
			const observed: QuickJSHandle[] = []
			let failureHandle: QuickJSHandle | undefined
			const getProp = ctx.getProp
			ctx.getProp = function (...args) {
				const handle = getProp.apply(this, args)
				observed.push(handle)
				if (scenario === `${args[1]} failure`) failureHandle = handle
				return handle
			}

			const dump = ctx.dump
			const getString = ctx.getString
			const failure = new Error('injected conversion failure')
			const dumpSpy = spyOn(ctx, 'dump').mockImplementation(handle => {
				if (handle === failureHandle) throw failure
				return dump.call(ctx, handle)
			})
			const stringSpy = spyOn(ctx, 'getString').mockImplementation(handle => {
				if (scenario === 'symbol failure') throw failure
				return getString.call(ctx, handle)
			})
			const code = scenario.endsWith('failure')
				? scenario === 'symbol failure'
					? "Symbol('key')"
					: "({[Symbol.toStringTag]:'CustomError',message:'broken',stack:'trace'})"
				: scenario === 'plain'
					? '({value:123,nested:{value:456}})'
					: `(() => {
						const o = {value:123,nested:{value:456},arr:[1,undefined,3],fn:function fn(){return 7}}
						Object.defineProperty(o, 'accessor', {get(){return 42},set(v){},enumerable:true,configurable:true})
						Object.defineProperty(o, 'hidden', {value:undefined})
						o[Symbol('key')] = 'symbol value'
						return o
					})()`

			try {
				for (let i = 0; i < 10; i++) {
					const scope = new Scope()
					const result = ctx.evalCode(code)
					try {
						expect(result.error).toBeUndefined()
						const convert = () => handleToNative(ctx, ctx.unwrapResult(result), scope)
						if (scenario.endsWith('failure')) {
							expect(convert).toThrow(failure)
						} else {
							const native = convert()
							expect(native.value).toBe(123)
							expect(native.nested.value).toBe(456)
							if (scenario === 'mixed') {
								expect(native.arr).toEqual([1, undefined, 3])
								expect(typeof native.fn).toBe('function')
								const accessor = Object.getOwnPropertyDescriptor(native, 'accessor')
								expect(typeof accessor?.get).toBe('function')
								expect(typeof accessor?.set).toBe('function')
								expect(Object.getOwnPropertyDescriptor(native, 'hidden')).toEqual({
									value: undefined,
									writable: false,
									enumerable: false,
									configurable: false,
								})
								const [key] = Object.getOwnPropertySymbols(native)
								expect(key.description).toBe('key')
								expect(native[key]).toBe('symbol value')
							}
						}
					} finally {
						scope.dispose()
						result.dispose()
					}
				}
				expect(observed.length).toBeGreaterThan(0)
				expect(observed.filter(handle => handle.alive)).toHaveLength(0)
			} finally {
				// Also clean up leaked handles when this regression test fails.
				for (const handle of observed) if (handle.alive) handle.dispose()
				dumpSpy.mockRestore()
				stringSpy.mockRestore()
				ctx.getProp = getProp
				ctx.dispose()
			}
		})
	})
}
