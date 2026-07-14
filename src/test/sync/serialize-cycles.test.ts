import { beforeAll, describe, expect, it, spyOn } from 'bun:test'
import variant from '@jitl/quickjs-ng-wasmfile-release-sync'
import { loadQuickJs } from '../../loadQuickJs.js'
import type { ErrorResponse } from '../../types/ErrorResponse.js'
import type { OkResponse } from '../../types/OkResponse.js'

describe('sync - serialize cycles', () => {
	let runtime: Awaited<ReturnType<typeof loadQuickJs>>

	beforeAll(async () => {
		runtime = await loadQuickJs(variant)
	})

	const execute = async (code: string): Promise<OkResponse | ErrorResponse> => {
		return await runtime.runSandboxed(async ({ evalCode }) => evalCode(code))
	}

	it('serializes a direct self-cycle without hanging, marking the back-ref [Circular]', async () => {
		const code = `
      const o = { a: 1 }
      o.self = o
      export default o
    `
		const result = await execute(code)
		expect(result.ok).toBeTrue()
		expect((result as OkResponse).data).toEqual({ a: 1, self: '[Circular]' })
	})

	it('serializes a mutual cycle', async () => {
		const code = `
      const a = { name: 'a' }
      const b = { name: 'b' }
      a.b = b
      b.a = a
      export default { a }
    `
		const result = await execute(code)
		expect(result.ok).toBeTrue()
		const data = (result as OkResponse).data as any
		expect(data.a.name).toBe('a')
		expect(data.a.b.name).toBe('b')
		// b.a points back to a, which is already being serialized -> circular
		expect(data.a.b.a).toBe('[Circular]')
	})

	it('serializes an array that contains itself', async () => {
		const code = `
      const arr = [1, 2]
      arr.push(arr)
      export default arr
    `
		const result = await execute(code)
		expect(result.ok).toBeTrue()
		const data = (result as OkResponse).data as any[]
		expect(data[0]).toBe(1)
		expect(data[1]).toBe(2)
		expect(data[2]).toBe('[Circular]')
	})

	it('does NOT mark shared-but-acyclic references as circular', async () => {
		const code = `
      const shared = { x: 1 }
      export default { a: shared, b: shared }
    `
		const result = await execute(code)
		expect(result.ok).toBeTrue()
		expect((result as OkResponse).data).toEqual({ a: { x: 1 }, b: { x: 1 } })
	})

	it('serializes a function that references itself via a property', async () => {
		const code = `
      function f() { return 1 }
      f.self = f
      f.tag = 'fn'
      export default f
    `
		const result = await execute(code)
		expect(result.ok).toBeTrue()
		const fn = (result as OkResponse).data as any
		expect(typeof fn).toBe('function')
		expect(fn.tag).toBe('fn')
		expect(fn.self).toBe('[Circular]')
	})

	it('serializes a cycle nested inside a Map value', async () => {
		const code = `
      const o = { k: 1 }
      o.self = o
      export default new Map([['entry', o]])
    `
		const result = await execute(code)
		expect(result.ok).toBeTrue()
		const map = (result as OkResponse).data as Map<string, any>
		expect(map).toBeInstanceOf(Map)
		expect(map.get('entry')).toEqual({ k: 1, self: '[Circular]' })
	})

	it('serializes a Set that contains itself', async () => {
		const code = `
      const s = new Set([1])
      s.add(s)
      export default s
    `
		const result = await execute(code)
		expect(result.ok).toBeTrue()
		const set = (result as OkResponse).data as Set<any>
		expect(set).toBeInstanceOf(Set)
		expect(set.has(1)).toBeTrue()
		expect(set.has('[Circular]')).toBeTrue()
	})

	it('serializes a deeply nested but acyclic object within the depth limit', async () => {
		const code = `
      let o = { v: 'leaf' }
      for (let i = 0; i < 120; i++) o = { child: o }
      export default o
    `
		const result = await execute(code)
		expect(result.ok).toBeTrue()
		// Walk down to confirm it serialized fully.
		let node = (result as OkResponse).data as any
		for (let i = 0; i < 120; i++) node = node.child
		expect(node).toEqual({ v: 'leaf' })
	})

	it('fails with a descriptive RangeError when the depth limit is exceeded', async () => {
		const code = `
      let o = { v: 'leaf' }
      for (let i = 0; i < 400; i++) o = { child: o }
      export default o
    `
		const result = await execute(code)
		expect(result.ok).toBeFalse()
		const error = (result as ErrorResponse).error
		expect(error.name).toBe('RangeError')
		expect(error.message).toMatch(/maximum object depth/)
		expect(error.message.length).toBeGreaterThan(0)
	})

	it('falls back to generic serialization when a value only reports a matching constructor', async () => {
		// `constructor.name` dispatch is unreliable: an object can report a built-in
		// constructor name (here "Date") without being an instance. The type-specific
		// serializer must not throw — it should fall back to serializing the plain object.
		const code = `
      function FakeDate() {}
      Object.defineProperty(FakeDate, 'name', { value: 'Date' })
      const o = { hello: 'world' }
      Object.defineProperty(o, 'constructor', { value: FakeDate, enumerable: false })
      export default o
    `
		const result = await execute(code)
		expect(result.ok).toBeTrue()
		expect((result as OkResponse).data).toEqual({ hello: 'world' })
	})

	it('serializes a function whose prototype chain pulls in a built-in (extends Date)', async () => {
		// Serializing a function walks its `prototype`, whose `constructor` is the class /
		// Date, previously misdispatched to serializeDate and threw "not a Date object".
		const code = `
      class MyDate extends Date {}
      export default { cls: MyDate }
    `
		const result = await execute(code)
		expect(result.ok).toBeTrue()
	})

	it('falls back when a non-Map value reports the Map constructor (container mis-dispatch)', async () => {
		// A `prototype` object whose constructor is Map is not a Map instance; the Map
		// serializer must fall back rather than throwing "Map object expected".
		const code = `
      const o = { hello: 'world' }
      Object.defineProperty(o, 'constructor', { value: Map, enumerable: false })
      export default o
    `
		const result = await execute(code)
		expect(result.ok).toBeTrue()
		expect((result as OkResponse).data).toEqual({ hello: 'world' })
	})

	it('serializes a function whose prototype derives from Map without error', async () => {
		const code = `
      function Wrap() {}
      Wrap.prototype = Object.create(Map.prototype)
      export default { w: Wrap }
    `
		const result = await execute(code)
		expect(result.ok).toBeTrue()
	})

	it('serializes two sibling references to the same real Map (no false circular)', async () => {
		const code = `
      const m = new Map([['k', 'v']])
      export default { a: m, b: m }
    `
		const result = await execute(code)
		expect(result.ok).toBeTrue()
		const data = (result as OkResponse).data as { a: Map<string, string>; b: Map<string, string> }
		expect(data.a).toBeInstanceOf(Map)
		expect(data.b).toBeInstanceOf(Map)
		expect(data.a.get('k')).toBe('v')
		expect(data.b.get('k')).toBe('v')
	})

	it('does not serialize a function prototype (avoids walking into global built-ins)', async () => {
		// Serializing a function must skip its `prototype` (and legacy caller/arguments);
		// otherwise the walk reaches guest built-in prototypes (Map.prototype, Date.prototype,
		// …) which report a matching constructor name but aren't instances. Real assigned
		// properties are still serialized.
		const code = `
      function greet() { return 'hi' }
      greet.customProp = 42
      greet.meta = { version: '1.0' }
      export default greet
    `
		const result = await execute(code)
		expect(result.ok).toBeTrue()
		const fn = (result as OkResponse).data as any
		expect(typeof fn).toBe('function')
		expect(fn.customProp).toBe(42)
		expect(fn.meta).toEqual({ version: '1.0' })
	})

	it('serializes a class that extends a built-in without leaking its prototype', async () => {
		const code = `
      class Repo extends Map {}
      Repo.label = 'repo'
      export default { Repo }
    `
		const result = await execute(code)
		expect(result.ok).toBeTrue()
		const cls = (result as OkResponse).data as any
		expect(typeof cls.Repo).toBe('function')
		expect(cls.Repo.label).toBe('repo')
	})

	it('never calls the host console.error while serializing a cyclic value', async () => {
		const consoleErrorSpy = spyOn(console, 'error')
		try {
			const code = `
        const o = {}
        o.self = o
        export default o
      `
			const result = await execute(code)
			expect(result.ok).toBeTrue()
			expect(consoleErrorSpy).not.toHaveBeenCalled()
		} finally {
			consoleErrorSpy.mockRestore()
		}
	})
})
