import { describe, expect, it, mock } from 'bun:test'
import { type GetFetchAdapterOptions, getDefaultFetchAdapter, HEADERS_MARKER } from './fetch.js'

describe('core - fetch adapter', () => {
	it('should block disallowed hosts', async () => {
		const adapterOptions: GetFetchAdapterOptions = {
			disallowedHosts: ['example.com'],
		}
		const fetchAdapter = getDefaultFetchAdapter(adapterOptions)

		const response = await fetchAdapter('http://example.com')

		expect(response.status).toBe(403)
		expect(response.statusText).toBe('FORBIDDEN')
	})

	it('should allow allowed hosts', async () => {
		const adapterOptions: GetFetchAdapterOptions = {
			allowedHosts: ['example.com'],
		}
		const fetchAdapter = getDefaultFetchAdapter(adapterOptions)

		const response = await fetchAdapter('http://example.com')

		expect(response.status).not.toBe(403)
	})

	it('should respect timeout', async () => {
		const adapterOptions: GetFetchAdapterOptions = {
			timeout: 1000,
		}
		const fetchAdapter = getDefaultFetchAdapter(adapterOptions)

		try {
			await fetchAdapter('http://example.com', { signal: AbortSignal.timeout(50) })
		} catch (error) {
			expect((error as Error).name).toBe('AbortError')
		}
	})

	it('should apply rate limiting', async () => {
		const adapterOptions: GetFetchAdapterOptions = {
			rateLimitPoints: 1,
			rateLimitDuration: 1,
		}
		const fetchAdapter = getDefaultFetchAdapter(adapterOptions)

		const response1 = await fetchAdapter('http://example.com')
		expect(response1.status).not.toBe(429)

		const response2 = await fetchAdapter('http://example.com')
		expect(response2.status).toBe(429)
		expect(response2.statusText).toBe('TOO MANY REQUESTS')
	})

	it('should not enforce CORS policy by default', async () => {
		const adapterOptions: GetFetchAdapterOptions = {}
		const fetchAdapter = getDefaultFetchAdapter(adapterOptions)

		// Mocking fetch to return a response without CORS headers
		global.fetch = Object.assign(mock().mockResolvedValue(new Response('', { status: 200, statusText: 'OK' })), {
			preconnect: async () => {},
		})

		const response = await fetchAdapter('http://example.com')
		expect(response.status).toBe(200)
		expect(response.statusText).toBe('OK')
	})

	it('should enforce CORS policy if enabled', async () => {
		const adapterOptions: GetFetchAdapterOptions = {
			corsCheck: true,
		}
		const fetchAdapter = getDefaultFetchAdapter(adapterOptions)

		// Mocking fetch to return a response without CORS headers
		global.fetch = Object.assign(mock().mockResolvedValue(new Response('', { status: 200, statusText: 'OK' })), {
			preconnect: async () => {},
		})

		const response = await fetchAdapter('http://example.com')
		expect(response.status).toBe(403)
		expect(response.statusText).toBe('FORBIDDEN')
	})

	it('should handle Request objects', async () => {
		const fetchAdapter = getDefaultFetchAdapter({})

		// Mock fetch to avoid real network call
		global.fetch = Object.assign(mock().mockResolvedValue(new Response('', { status: 200, statusText: 'OK' })), {
			preconnect: async () => {},
		})

		const req = new Request('http://example.com')
		const response = await fetchAdapter(req)
		expect(response.status).toBe(200)
		expect(response.statusText).toBe('OK')
	})
})

describe('core - fetch adapter request header normalization', () => {
	// Capture what reaches host fetch and expose it as a native Headers for assertions.
	const setupCapture = () => {
		const calls: Array<{ input: unknown; init?: RequestInit }> = []
		const originalFetch = global.fetch
		global.fetch = Object.assign(
			mock(async (input: unknown, init?: RequestInit) => {
				calls.push({ input, init })
				return new Response('', { status: 200, statusText: 'OK' })
			}),
			{ preconnect: async () => {} },
		) as unknown as typeof fetch
		const restore = () => {
			global.fetch = originalFetch
		}
		return { calls, restore }
	}

	const sentHeaders = (init?: RequestInit) => new Headers(init?.headers as HeadersInit)

	it('passes a plain object header through unchanged', async () => {
		const { calls, restore } = setupCapture()
		try {
			const fetchAdapter = getDefaultFetchAdapter({})
			await fetchAdapter('http://example.com', {
				method: 'POST',
				headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
			})
			const h = sentHeaders(calls[0]?.init)
			expect(h.get('authorization')).toBe('Bearer token')
			expect(h.get('content-type')).toBe('application/json')
			expect(h.has('_headers')).toBeFalse()
		} finally {
			restore()
		}
	})

	it('passes a native Headers object through', async () => {
		const { calls, restore } = setupCapture()
		try {
			const fetchAdapter = getDefaultFetchAdapter({})
			const headers = new Headers({ authorization: 'Bearer token', 'content-type': 'application/json' })
			await fetchAdapter('http://example.com', { method: 'POST', headers })
			const h = sentHeaders(calls[0]?.init)
			expect(h.get('authorization')).toBe('Bearer token')
			expect(h.get('content-type')).toBe('application/json')
			expect(h.has('_headers')).toBeFalse()
		} finally {
			restore()
		}
	})

	it('flattens our createHeadersObject shape (_headers plain object + marker)', async () => {
		const { calls, restore } = setupCapture()
		try {
			const fetchAdapter = getDefaultFetchAdapter({})
			const headersLike = {
				[HEADERS_MARKER]: true,
				_headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
			}
			await fetchAdapter('http://example.com', { method: 'POST', headers: headersLike as unknown as HeadersInit })
			const h = sentHeaders(calls[0]?.init)
			expect(h.get('authorization')).toBe('Bearer token')
			expect(h.get('content-type')).toBe('application/json')
			expect(h.has('_headers')).toBeFalse()
		} finally {
			restore()
		}
	})

	it('flattens the { _headers: Map } shape from the handoff repro', async () => {
		const { calls, restore } = setupCapture()
		try {
			const fetchAdapter = getDefaultFetchAdapter({})
			const headersLike = {
				_headers: new Map([
					['authorization', 'Bearer token'],
					['content-type', 'application/json'],
				]),
			}
			await fetchAdapter('http://example.com', { method: 'POST', headers: headersLike as unknown as HeadersInit })
			const h = sentHeaders(calls[0]?.init)
			expect(h.get('authorization')).toBe('Bearer token')
			expect(h.get('content-type')).toBe('application/json')
			expect(h.has('_headers')).toBeFalse()
		} finally {
			restore()
		}
	})

	it('flattens the sandbox Headers polyfill shape ({ map: { name: [value] } })', async () => {
		const { calls, restore } = setupCapture()
		try {
			const fetchAdapter = getDefaultFetchAdapter({})
			const headersLike = {
				map: {
					authorization: ['Bearer token'],
					'content-type': ['application/json'],
				},
			}
			await fetchAdapter('http://example.com', { method: 'POST', headers: headersLike as unknown as HeadersInit })
			const h = sentHeaders(calls[0]?.init)
			expect(h.get('authorization')).toBe('Bearer token')
			expect(h.get('content-type')).toBe('application/json')
			expect(h.has('_headers')).toBeFalse()
			expect(h.has('map')).toBeFalse()
		} finally {
			restore()
		}
	})

	it('forwards the URL string (not the raw input object) to host fetch', async () => {
		const { calls, restore } = setupCapture()
		try {
			const fetchAdapter = getDefaultFetchAdapter({})
			await fetchAdapter(new URL('http://example.com/path'), { method: 'GET' })
			expect(calls[0]?.input).toBe('http://example.com/path')
		} finally {
			restore()
		}
	})
})
