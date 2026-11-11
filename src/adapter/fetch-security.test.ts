import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDefaultFetchAdapter, isPrivateAddress } from './fetch.js'

const realFetch = globalThis.fetch

const base = { rateLimitPoints: 100000, rateLimitDuration: 1 }

type Call = { input: unknown; init?: RequestInit }

/** Replace host fetch with a recorder. Returns the recorded calls. */
const spyFetch = (respond: (input: unknown, init?: RequestInit) => Response = () => new Response('ok')) => {
	const calls: Call[] = []
	globalThis.fetch = Object.assign(
		async (input: unknown, init?: RequestInit) => {
			calls.push({ input, init })
			return respond(input, init)
		},
		{ preconnect: async () => {} },
	) as unknown as typeof fetch
	return calls
}

afterEach(() => {
	globalThis.fetch = realFetch
})

describe('isPrivateAddress', () => {
	const cases: Array<[string, boolean]> = [
		['0.0.0.0', true],
		['0.255.255.255', true],
		['10.1.2.3', true],
		['100.64.0.1', true],
		['100.127.255.255', true],
		['100.128.0.1', false],
		['100.63.255.255', false],
		['127.0.0.1', true],
		['127.255.255.254', true],
		['169.254.169.254', true],
		['169.253.0.1', false],
		['172.15.255.255', false],
		['172.16.0.1', true],
		['172.31.255.255', true],
		['172.32.0.1', false],
		['192.168.0.1', true],
		['192.167.0.1', false],
		['192.0.0.1', true],
		['192.0.2.1', false],
		['198.17.255.255', false],
		['198.18.0.1', true],
		['198.19.255.255', true],
		['198.20.0.1', false],
		['223.255.255.255', false],
		['224.0.0.1', true],
		['255.255.255.255', true],
		['8.8.8.8', false],
		['93.184.216.34', false],
		['::', true],
		['::1', true],
		['[::1]', true],
		['fc00::1', true],
		['fd12:3456::1', true],
		['fe80::1', true],
		['febf::1', true],
		['ff02::1', true],
		['::ffff:7f00:1', true],
		['::ffff:127.0.0.1', true],
		['::ffff:a00:1', true],
		['::ffff:808:808', false],
		['::ffff:8.8.8.8', false],
		['64:ff9b::7f00:1', true],
		['64:ff9b::808:808', false],
		['2002:7f00:1::', true],
		['2002:808:808::', false],
		['2001:4860:4860::8888', false],
		['2606:4700:4700::1111', false],
		['not-an-ip', true],
		['1.2.3', true],
		['1.2.3.256', true],
	]
	for (const [ip, expected] of cases) {
		it(`${ip} -> ${expected}`, () => {
			expect(isPrivateAddress(ip)).toBe(expected)
		})
	}
})

describe('fetch adapter - host validation', () => {
	const blocked = [
		'http://localhost/',
		'http://127.0.0.1/',
		'http://0.0.0.0:8080/',
		'http://127.0.0.2/',
		'http://localhost./',
		'http://LOCALHOST/',
		'http://foo.localhost/',
		'http://foo.localhost./',
		'http://[::1]/',
		'http://[::ffff:127.0.0.1]/',
		'http://[::ffff:7f00:1]/',
		'http://[::]/',
		'http://[fd00::1]/',
		'http://[fe80::1]/',
		'http://[64:ff9b::7f00:1]/',
		'http://[2002:7f00:1::]/',
		'http://2130706433/',
		'http://0x7f.1/',
		'http://127.1/',
		'http://0177.0.0.1/',
		'http://169.254.169.254/latest/meta-data/',
		'http://10.0.0.1/',
		'http://172.16.0.1/',
		'http://192.168.1.1/',
		'http://100.64.0.1/',
		'http://198.18.0.1/',
		'http://224.0.0.1/',
		'http://255.255.255.255/',
	]
	for (const url of blocked) {
		it(`blocks ${url} by default`, async () => {
			const calls = spyFetch()
			const adapter = getDefaultFetchAdapter({ ...base })
			const res = await adapter(url)
			expect(res.status).toBe(403)
			expect(calls.length).toBe(0)
		})
	}

	it('allows a public IP literal', async () => {
		const calls = spyFetch()
		const adapter = getDefaultFetchAdapter({ ...base })
		const res = await adapter('http://93.184.216.34/')
		expect(res.status).toBe(200)
		expect(calls.length).toBe(1)
	})

	it('disallowedHosts entries are normalised (case, trailing dot)', async () => {
		const calls = spyFetch()
		const adapter = getDefaultFetchAdapter({
			...base,
			disallowedHosts: ['Example.COM.'],
			dnsLookup: async () => ['93.184.216.34'],
		})
		expect((await adapter('http://example.com/')).status).toBe(403)
		expect((await adapter('http://example.com./')).status).toBe(403)
		expect(calls.length).toBe(0)
	})

	it('disallowPrivateNetworks: false restores access but explicit disallowedHosts still blocks', async () => {
		const calls = spyFetch()
		const adapter = getDefaultFetchAdapter({ ...base, disallowPrivateNetworks: false })
		expect((await adapter('http://10.0.0.1/')).status).toBe(200)
		expect((await adapter('http://[::ffff:7f00:2]/')).status).toBe(200)
		expect((await adapter('http://127.0.0.1/')).status).toBe(403) // explicit default denylist
		expect((await adapter('http://localhost./')).status).toBe(403)
		expect((await adapter('http://foo.localhost/')).status).toBe(403)
		expect(calls.length).toBe(2)

		const adapter2 = getDefaultFetchAdapter({ ...base, disallowPrivateNetworks: false, disallowedHosts: ['10.0.0.1'] })
		expect((await adapter2('http://10.0.0.1/')).status).toBe(403)
		expect((await adapter2('http://10.0.0.2/')).status).toBe(200)
	})

	it('explicit allowedHosts entry exempts the host from the implicit private block', async () => {
		const calls = spyFetch()
		const adapter = getDefaultFetchAdapter({ ...base, allowedHosts: ['10.0.0.1', '[::1]'], disallowedHosts: [] })
		expect((await adapter('http://10.0.0.1/')).status).toBe(200)
		expect((await adapter('http://[::1]/')).status).toBe(200)
		expect((await adapter('http://10.0.0.2/')).status).toBe(403) // not in allowedHosts
		expect(calls.length).toBe(2)
	})

	it('allowedHosts never overrides an explicit disallowedHosts entry', async () => {
		const calls = spyFetch()
		const adapter = getDefaultFetchAdapter({ ...base, allowedHosts: ['127.0.0.1'] })
		expect((await adapter('http://127.0.0.1/')).status).toBe(403)
		expect(calls.length).toBe(0)
	})

	it('blocks a DNS name that resolves to a private address (any address)', async () => {
		const calls = spyFetch()
		const lookups: string[] = []
		const adapter = getDefaultFetchAdapter({
			...base,
			dnsLookup: async host => {
				lookups.push(host)
				return host === 'mixed.example' ? ['93.184.216.34', '10.0.0.5'] : ['169.254.169.254']
			},
		})
		expect((await adapter('http://evil.example/')).status).toBe(403)
		expect((await adapter('http://mixed.example/')).status).toBe(403)
		expect(lookups).toEqual(['evil.example', 'mixed.example'])
		expect(calls.length).toBe(0)
	})

	it('allows a DNS name that resolves to public addresses only', async () => {
		const calls = spyFetch()
		const adapter = getDefaultFetchAdapter({
			...base,
			dnsLookup: async () => ['93.184.216.34', '2606:4700:4700::1111'],
		})
		expect((await adapter('http://good.example/')).status).toBe(200)
		expect(calls.length).toBe(1)
	})

	it('fails closed when the resolver errors or times out', async () => {
		const calls = spyFetch()
		const failing = getDefaultFetchAdapter({
			...base,
			dnsLookup: async () => {
				throw new Error('ENOTFOUND')
			},
		})
		expect((await failing('http://nx.example/')).status).toBe(403)
		const hanging = getDefaultFetchAdapter({ ...base, timeout: 50, dnsLookup: () => new Promise<string[]>(() => {}) })
		expect((await hanging('http://slow.example/')).status).toBe(403)
		expect(calls.length).toBe(0)
	})

	it('skips DNS resolution for hosts in allowedHosts and when disallowPrivateNetworks is false', async () => {
		spyFetch()
		let lookups = 0
		const dnsLookup = async () => {
			lookups++
			return ['10.0.0.5']
		}
		const a1 = getDefaultFetchAdapter({ ...base, allowedHosts: ['internal.example'], dnsLookup })
		expect((await a1('http://internal.example/')).status).toBe(200)
		const a2 = getDefaultFetchAdapter({ ...base, disallowPrivateNetworks: false, dnsLookup })
		expect((await a2('http://internal.example/')).status).toBe(200)
		expect(lookups).toBe(0)
	})

	it('does not crash when options are explicitly undefined', async () => {
		const calls = spyFetch()
		const adapter = getDefaultFetchAdapter({
			...base,
			disallowedHosts: undefined,
			allowedProtocols: undefined,
			timeout: undefined,
			disallowPrivateNetworks: undefined,
			dnsLookup: async () => ['93.184.216.34'],
		})
		expect((await adapter('http://localhost/')).status).toBe(403)
		expect((await adapter('http://example.com/')).status).toBe(200)
		expect(calls.length).toBe(1)
	})

	it('still serves file: URLs from the virtual fs when allowed', async () => {
		const { createFsFromVolume, Volume } = await import('memfs')
		const vol = new Volume()
		vol.fromJSON({ '/a.txt': 'hello' })
		const adapter = getDefaultFetchAdapter({
			...base,
			allowedProtocols: ['file:', 'http:'],
			fs: createFsFromVolume(vol),
		})
		const res = await adapter('file:///a.txt')
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('hello')
		expect((await adapter('file:///missing.txt')).status).toBe(404)
		// file: not in allowedProtocols by default
		expect((await getDefaultFetchAdapter({ ...base })('file:///a.txt')).status).toBe(403)
	})
})

describe('fetch adapter - guest init is allowlisted', () => {
	it('forwards only method, headers, body and an adapter-controlled redirect/signal', async () => {
		const calls = spyFetch()
		const adapter = getDefaultFetchAdapter({ ...base, dnsLookup: async () => ['93.184.216.34'] })
		const guestSignal = new AbortController().signal
		await adapter('http://example.com/', {
			method: 'POST',
			headers: { 'x-a': '1' },
			body: 'payload',
			unix: '/var/run/docker.sock',
			proxy: 'http://attacker.example:8080',
			tls: { rejectUnauthorized: false },
			dispatcher: {},
			signal: guestSignal,
			credentials: 'include',
			keepalive: true,
			verbose: true,
		} as unknown as RequestInit)
		expect(calls.length).toBe(1)
		const init = calls[0].init as unknown as { redirect: unknown; signal: unknown; method: unknown; body: unknown }
		expect(Object.keys(init).sort()).toEqual(['body', 'headers', 'method', 'redirect', 'signal'])
		expect(init.redirect).toBe('error')
		expect(init.signal).not.toBe(guestSignal)
		expect(init.method).toBe('POST')
		expect(init.body).toBe('payload')
	})

	it('passes redirect: manual through and maps redirect: follow to manual', async () => {
		const calls = spyFetch()
		const adapter = getDefaultFetchAdapter({ ...base, dnsLookup: async () => ['93.184.216.34'] })
		await adapter('http://example.com/', { redirect: 'manual' })
		await adapter('http://example.com/', { redirect: 'follow' })
		await adapter('http://example.com/', { redirect: 'bogus' as RequestRedirect })
		expect(calls.map(c => c.init?.redirect)).toEqual(['manual', 'manual', 'error'])
	})

	it('does not return a unix-socket server body when the guest passes `unix`', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-sec-'))
		const sock = path.join(dir, 's.sock')
		const unixServer = Bun.serve({ unix: sock, fetch: () => new Response('UNIX-SECRET') })
		const tcpServer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('TCP-BODY') })
		try {
			const adapter = getDefaultFetchAdapter({ ...base, allowedHosts: ['127.0.0.1'], disallowedHosts: [] })
			const res = await adapter(`http://127.0.0.1:${tcpServer.port}/`, { unix: sock } as unknown as RequestInit)
			expect(await res.text()).toBe('TCP-BODY')
		} finally {
			await unixServer.stop(true)
			await tcpServer.stop(true)
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it('applies the same validation and init allowlist to native Request inputs', async () => {
		const calls = spyFetch()
		const adapter = getDefaultFetchAdapter({ ...base, dnsLookup: async () => ['93.184.216.34'] })
		const req = new Request('http://example.com/')
		await adapter(req, { unix: '/x', proxy: 'http://p' } as unknown as RequestInit)
		expect(calls[0].input).toBe(req)
		expect(Object.keys(calls[0].init as object).sort()).toEqual(['redirect', 'signal'])
		expect((await adapter(new Request('http://127.0.0.1/'))).status).toBe(403)
		expect((await adapter(new Request('http://[::1]/'))).status).toBe(403)
		expect(calls.length).toBe(1)
	})
})

describe('fetch adapter - redirects', () => {
	let a: ReturnType<typeof Bun.serve>
	let b: ReturnType<typeof Bun.serve>
	let urlA: string
	let urlB: string

	beforeAll(() => {
		b = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			async fetch(req) {
				const body = await req.text()
				return Response.json({
					method: req.method,
					authorization: req.headers.get('authorization'),
					cookie: req.headers.get('cookie'),
					custom: req.headers.get('x-custom'),
					contentType: req.headers.get('content-type'),
					body,
				})
			},
		})
		urlB = `http://127.0.0.1:${b.port}`
		a = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			fetch(req) {
				const url = new URL(req.url)
				const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } })
				switch (url.pathname) {
					case '/to-metadata':
						return redirect('http://169.254.169.254/latest/meta-data/')
					case '/to-localhost':
						return redirect(`http://localhost:${b.port}/`)
					case '/to-ipv6':
						return redirect('http://[::1]/')
					case '/to-file':
						return redirect('file:///etc/passwd')
					case '/relative':
						return redirect('/echo')
					case '/echo':
						return new Response('echo-a')
					case '/to-b':
						return redirect(`${urlB}/`)
					case '/to-b-307':
						return redirect(`${urlB}/`, 307)
					case '/to-b-303':
						return redirect(`${urlB}/`, 303)
					case '/same-origin':
						return redirect('/echo-headers')
					case '/echo-headers':
						return Response.json({ authorization: req.headers.get('authorization') })
					case '/loop':
						return redirect('/loop')
					default: {
						const m = url.pathname.match(/^\/chain\/(\d+)$/)
						if (m) {
							const n = Number(m[1])
							return n === 0 ? new Response('end') : redirect(`/chain/${n - 1}`)
						}
						return new Response('a-root')
					}
				}
			},
		})
		urlA = `http://127.0.0.1:${a.port}`
	})

	afterAll(async () => {
		await a.stop(true)
		await b.stop(true)
	})

	// Both local servers are explicitly allowed; localhost / metadata / ::1 are not.
	const make = () => getDefaultFetchAdapter({ ...base, allowedHosts: ['127.0.0.1'], disallowedHosts: [] })

	it('errors on redirect by default', async () => {
		const err = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const res = await make()(`${urlA}/relative`)
			expect(res.status).toBe(500)
		} finally {
			err.mockRestore()
		}
	})

	it('redirect: manual returns the 3xx without following', async () => {
		const res = await make()(`${urlA}/to-metadata`, { redirect: 'manual' })
		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe('http://169.254.169.254/latest/meta-data/')
	})

	for (const p of ['/to-metadata', '/to-localhost', '/to-ipv6', '/to-file']) {
		it(`redirect: follow to a blocked target (${p}) returns 403`, async () => {
			const res = await make()(`${urlA}${p}`, { redirect: 'follow' })
			expect(res.status).toBe(403)
		})
	}

	it('redirect: follow follows a relative redirect to a permitted host', async () => {
		const res = await make()(`${urlA}/relative`, { redirect: 'follow' })
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('echo-a')
	})

	it('enforces the hop limit (5 redirects ok, 6 fails)', async () => {
		const err = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const ok = await make()(`${urlA}/chain/5`, { redirect: 'follow' })
			expect(ok.status).toBe(200)
			expect(await ok.text()).toBe('end')
			const tooMany = await make()(`${urlA}/chain/6`, { redirect: 'follow' })
			expect(tooMany.status).toBe(500)
			const loop = await make()(`${urlA}/loop`, { redirect: 'follow' })
			expect(loop.status).toBe(500)
		} finally {
			err.mockRestore()
		}
	})

	it('strips authorization and cookie on cross-origin redirect but keeps other headers', async () => {
		const res = await make()(`${urlA}/to-b`, {
			redirect: 'follow',
			headers: { authorization: 'Bearer secret', cookie: 'sid=1', 'x-custom': 'keep' },
		})
		const json = (await res.json()) as { authorization: string | null; cookie: string | null; custom: string | null }
		expect(json.authorization).toBeNull()
		expect(json.cookie).toBeNull()
		expect(json.custom).toBe('keep')
	})

	it('keeps authorization on same-origin redirect', async () => {
		const res = await make()(`${urlA}/same-origin`, { redirect: 'follow', headers: { authorization: 'Bearer secret' } })
		expect(((await res.json()) as { authorization: string }).authorization).toBe('Bearer secret')
	})

	it('307 keeps method and body; 303 switches to GET without body', async () => {
		const r307 = await make()(`${urlA}/to-b-307`, {
			redirect: 'follow',
			method: 'POST',
			body: 'data',
			headers: { 'content-type': 'text/plain' },
		})
		expect(await r307.json()).toMatchObject({ method: 'POST', body: 'data', contentType: 'text/plain' })

		const r303 = await make()(`${urlA}/to-b-303`, {
			redirect: 'follow',
			method: 'POST',
			body: 'data',
			headers: { 'content-type': 'text/plain' },
		})
		expect(await r303.json()).toMatchObject({ method: 'GET', body: '', contentType: null })

		const r302 = await make()(`${urlA}/to-b`, { redirect: 'follow', method: 'POST', body: 'data' })
		expect(await r302.json()).toMatchObject({ method: 'GET', body: '' })
	})

	it('replays a native Request body on a 307 hop', async () => {
		const req = new Request(`${urlA}/to-b-307`, {
			method: 'POST',
			body: 'native-data',
			headers: { 'content-type': 'text/plain' },
		})
		const res = await make()(req, { redirect: 'follow' })
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ method: 'POST', body: 'native-data', contentType: 'text/plain' })
	})

	it('redirect: follow to a DNS name resolving to a private address is blocked', async () => {
		const calls = spyFetch(input =>
			String(input).startsWith('http://first.example')
				? new Response(null, { status: 302, headers: { location: 'http://rebind.example/' } })
				: new Response('should-not-reach'),
		)
		const adapter = getDefaultFetchAdapter({
			...base,
			dnsLookup: async host => (host === 'rebind.example' ? ['192.168.0.10'] : ['93.184.216.34']),
		})
		const res = await adapter('http://first.example/', { redirect: 'follow' })
		expect(res.status).toBe(403)
		expect(calls.length).toBe(1)
	})
})
