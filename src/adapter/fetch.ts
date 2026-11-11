import type { IFs } from 'memfs'
import { RateLimiterMemory } from 'rate-limiter-flexible'

const DISALLOW_HOSTS_DEFAULT = ['localhost', '127.0.0.1']
const DEFAULT_TIMEOUT = 5000 // 5 seconds
const DEFAULT_RATE_LIMIT_POINTS = 10 // Number of requests
const DEFAULT_RATE_LIMIT_DURATION = 1 // Per second
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const SENSITIVE_HEADERS_ON_CROSS_ORIGIN = ['authorization', 'cookie', 'proxy-authorization']
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']

/**
 * Options for creating the default fetch adapter
 */
export type GetFetchAdapterOptions = {
	/**
	 * The virtual file system of the sandbox (excludes node_modules)
	 */
	fs?: IFs
	/**
	 * List of allowed hosts. If set, only these hosts are allowed to call
	 */
	allowedHosts?: string[]
	/**
	 * List of allowed protocols. If set, only these protocols are allowed to call
	 */
	allowedProtocols?: string[]
	/**
	 * List of disallowed hosts. If set, these hosts are not allowed to call
	 * @default ['localhost', '127.0.0.1']
	 */
	disallowedHosts?: string[]
	/**
	 * Reject requests to private / loopback / link-local / reserved network addresses
	 * (IPv4 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 192.0.0/24, 198.18/15,
	 * 224/4 and above; IPv6 `::`, `::1`, fc00::/7, fe80::/10, ff00::/8 and IPv4-mapped / NAT64 /
	 * 6to4 embeddings of those). Literal IP hosts are checked directly; host names are resolved
	 * (best effort, pre-flight) and rejected if any address is private. A host listed explicitly in
	 * `allowedHosts` is exempt from this implicit block, but never from `disallowedHosts`.
	 * @default true
	 */
	disallowPrivateNetworks?: boolean
	/**
	 * Custom DNS resolver used for the private-network pre-flight check. Must return all
	 * resolved addresses. Defaults to `node:dns/promises` `lookup(host, { all: true })`
	 * (skipped if that module is unavailable, e.g. in browsers).
	 */
	dnsLookup?: (hostname: string) => Promise<string[]>
	/**
	 * Timeout for fetch requests in milliseconds
	 * @default 5000
	 */
	timeout?: number
	/**
	 * Flag to enable CORS policy check
	 * @default false
	 */
	corsCheck?: boolean
	/**
	 * List of allowed CORS origins
	 * @default ['*']
	 */
	allowedCorsOrigins?: string[]
	/**
	 * Number of requests allowed in the specified duration
	 * @default 10
	 */
	rateLimitPoints?: number
	/**
	 * Duration in seconds for the rate limit
	 * @default 1
	 */
	rateLimitDuration?: number
}

/**
 * Symbol to mark an object as a Headers-like object for sandbox serialization
 */
export const HEADERS_MARKER = Symbol.for('quickjs-headers')

/**
 * Create a Headers-like object from a plain headers object
 * This provides the standard Headers API methods while remaining serializable
 * The HEADERS_MARKER symbol is used by the sandbox to reconstruct proper Headers instances
 */
const createHeadersObject = (headersObj: Record<string, string>) => ({
	[HEADERS_MARKER]: true,
	_headers: headersObj,
	get(name: string): string | null {
		const key = Object.keys(headersObj).find(k => k.toLowerCase() === name.toLowerCase())
		return key ? headersObj[key] : null
	},
	has(name: string): boolean {
		return Object.keys(headersObj).some(k => k.toLowerCase() === name.toLowerCase())
	},
	entries(): IterableIterator<[string, string]> {
		return Object.entries(headersObj)[Symbol.iterator]() as IterableIterator<[string, string]>
	},
	keys(): IterableIterator<string> {
		return Object.keys(headersObj)[Symbol.iterator]()
	},
	values(): IterableIterator<string> {
		return Object.values(headersObj)[Symbol.iterator]()
	},
	forEach(callback: (value: string, key: string) => void): void {
		for (const [key, value] of Object.entries(headersObj)) {
			callback(value, key)
		}
	},
	[Symbol.iterator](): IterableIterator<[string, string]> {
		return Object.entries(headersObj)[Symbol.iterator]() as IterableIterator<[string, string]>
	},
})

/**
 * Normalize a headers-like value into a valid `HeadersInit` before it is handed to
 * host `fetch`.
 *
 * Sandbox / consumer code can pass several non-native shapes as `init.headers`:
 * - our own {@link createHeadersObject} output, which stores data under an
 *   enumerable `_headers` property (marked with {@link HEADERS_MARKER}),
 * - a `{ _headers: Map }` variant produced by consumer polyfills,
 * - the sandbox `Headers` polyfill, which keeps values under a `map` object as
 *   arrays (see `src/modules/nodeCompatibility/headers.js`).
 *
 * Passing any of these straight through makes undici treat `_headers` (or `map`) as
 * a literal HTTP header name and stringify it to `[object Map]`, dropping the real
 * headers. Flattening them here keeps a single, correct request path.
 */
const normalizeHeadersInit = (headers: unknown): HeadersInit | undefined => {
	if (!headers) return undefined

	// Already a native/host Headers object — pass through untouched.
	if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers

	const h = headers as Record<string, unknown> & {
		_headers?: unknown
		map?: unknown
		entries?: unknown
	}

	// Our createHeadersObject shape (or a consumer polyfill mirroring it).
	if (h._headers instanceof Map) {
		return Object.fromEntries(h._headers.entries())
	}
	if (h._headers && typeof h._headers === 'object') {
		return { ...(h._headers as Record<string, string>) }
	}

	// Sandbox Headers polyfill shape: `map` holds arrays of values per header name.
	if (h.map && typeof h.map === 'object') {
		return Object.fromEntries(
			Object.entries(h.map as Record<string, unknown>).map(([name, value]) => [
				name,
				Array.isArray(value) ? value.join(', ') : String(value),
			]),
		)
	}

	// Generic Headers-like object exposing an iterator of entries.
	if (typeof h.entries === 'function') {
		return Object.fromEntries((h as { entries(): Iterable<[string, string]> }).entries())
	}

	// Valid HeadersInit forms.
	if (Array.isArray(headers)) return headers as HeadersInit
	if (typeof headers === 'object') return { ...(headers as Record<string, string>) }

	return headers as HeadersInit
}

/**
 * Map a fetch Response to a simplified response object
 * @param res The original response
 * @returns The mapped response object
 */
const mapResponse = (res: Response) =>
	({
		status: res.status,
		ok: res.ok,
		statusText: res.statusText,
		json: () => res.json(),
		text: () => res.text(),
		formData: () => res.formData(),
		headers: createHeadersObject(Object.fromEntries(res.headers.entries())),
		type: res.type,
		url: res.url,
		blob: () => res.blob(),
		bodyUsed: res.bodyUsed,
		redirected: res.redirected,
		body: undefined,
		arrayBuffer: () => res.arrayBuffer(),
		clone: () => res.clone(),
		bytes: res.bytes,
	}) as unknown as ReturnType<typeof fetch>

/**
 * Create a 403 forbidden response
 * @returns A 403 forbidden response
 */
const getForbiddenResponse = () => {
	const res = new Response('', { status: 403, statusText: 'FORBIDDEN' })
	return mapResponse(res)
}

const parseIPv4 = (ip: string): number[] | null => {
	const parts = ip.split('.')
	if (parts.length !== 4) return null
	const out: number[] = []
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null
		const n = Number(part)
		if (n > 255) return null
		out.push(n)
	}
	return out
}

const parseIPv6 = (input: string): number[] | null => {
	let s = input
	const zone = s.indexOf('%')
	if (zone >= 0) s = s.slice(0, zone)
	if (s.includes('.')) {
		const lastColon = s.lastIndexOf(':')
		const v4 = parseIPv4(s.slice(lastColon + 1))
		if (!v4) return null
		s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
	}
	const halves = s.split('::')
	if (halves.length > 2) return null
	const split = (part: string) => (part === '' ? [] : part.split(':'))
	const head = split(halves[0])
	let groups: string[]
	if (halves.length === 2) {
		const tail = split(halves[1])
		const fill = 8 - head.length - tail.length
		if (fill < 1) return null
		groups = [...head, ...new Array<string>(fill).fill('0'), ...tail]
	} else {
		groups = head
	}
	if (groups.length !== 8) return null
	const out: number[] = []
	for (const g of groups) {
		if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
		out.push(Number.parseInt(g, 16))
	}
	return out
}

const isPrivateIPv4 = ([a, b, c]: number[]): boolean =>
	a === 0 ||
	a === 10 ||
	(a === 100 && b >= 64 && b <= 127) ||
	a === 127 ||
	(a === 169 && b === 254) ||
	(a === 172 && b >= 16 && b <= 31) ||
	(a === 192 && b === 168) ||
	(a === 192 && b === 0 && c === 0) ||
	(a === 198 && (b === 18 || b === 19)) ||
	a >= 224

/**
 * Whether an IP literal (IPv4, or IPv6 with or without brackets) is in a private, loopback,
 * link-local, multicast or otherwise reserved range. Strings that cannot be parsed as an IP
 * address are treated as private (fail closed).
 */
export const isPrivateAddress = (ip: string): boolean => {
	const addr = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip
	if (!addr.includes(':')) {
		const v4 = parseIPv4(addr)
		return v4 ? isPrivateIPv4(v4) : true
	}
	const g = parseIPv6(addr)
	if (!g) return true
	const embedded = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]
	// :: and ::1 (and the deprecated IPv4-compatible ::a.b.c.d form)
	if (g.slice(0, 6).every(x => x === 0)) return isPrivateIPv4(embedded(g[6], g[7])) || (g[6] === 0 && g[7] <= 1)
	// IPv4-mapped ::ffff:a.b.c.d
	if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return isPrivateIPv4(embedded(g[6], g[7]))
	// NAT64 64:ff9b::/96
	if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return isPrivateIPv4(embedded(g[6], g[7]))
	// 6to4 2002::/16 embeds the IPv4 address in groups 1-2
	if (g[0] === 0x2002 && isPrivateIPv4(embedded(g[1], g[2]))) return true
	if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
	if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link local
	if ((g[0] & 0xffc0) === 0xfec0) return true // fec0::/10 deprecated site local
	if ((g[0] & 0xff00) === 0xff00) return true // ff00::/8 multicast
	return false
}

/** Lowercase, strip IPv6 brackets and a single trailing dot. */
const normalizeHost = (host: string): string => {
	let h = host.toLowerCase()
	if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
	if (h.endsWith('.')) h = h.slice(0, -1)
	return h
}

const defaultDnsLookup = async (hostname: string): Promise<string[]> => {
	const dns = await import('node:dns/promises')
	const results = await dns.lookup(hostname, { all: true })
	return results.map(r => r.address)
}

/**
 * Create a default fetch adapter
 * @param adapterOptions Options for creating the fetch adapter
 * @returns A fetch adapter function
 */
export const getDefaultFetchAdapter = (adapterOptions: GetFetchAdapterOptions = {}): typeof fetch => {
	const options = {
		fs: adapterOptions.fs,
		allowedHosts: adapterOptions.allowedHosts,
		allowedProtocols: adapterOptions.allowedProtocols ?? ['http:', 'https:'],
		disallowedHosts: adapterOptions.disallowedHosts ?? DISALLOW_HOSTS_DEFAULT,
		disallowPrivateNetworks: adapterOptions.disallowPrivateNetworks ?? true,
		dnsLookup: adapterOptions.dnsLookup ?? defaultDnsLookup,
		timeout: adapterOptions.timeout ?? DEFAULT_TIMEOUT,
		corsCheck: adapterOptions.corsCheck ?? false,
		allowedCorsOrigins: adapterOptions.allowedCorsOrigins ?? ['*'],
		rateLimitPoints: adapterOptions.rateLimitPoints ?? DEFAULT_RATE_LIMIT_POINTS,
		rateLimitDuration: adapterOptions.rateLimitDuration ?? DEFAULT_RATE_LIMIT_DURATION,
	}
	const disallowedHosts = options.disallowedHosts.map(normalizeHost)
	const allowedHosts = options.allowedHosts?.map(normalizeHost)

	const rateLimiter = new RateLimiterMemory({
		points: options.rateLimitPoints,
		duration: options.rateLimitDuration,
	})

	/** Resolve a host name best-effort and report whether any address is private. */
	const resolvesToPrivate = async (host: string): Promise<boolean> => {
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			const addresses = await Promise.race([
				options.dnsLookup(host),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error('DNS lookup timed out')), options.timeout)
				}),
			])
			return addresses.some(isPrivateAddress)
		} catch {
			// Resolver unavailable or resolution failed: let the fetch proceed and fail naturally.
			return false
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	/**
	 * Full URL validation (protocol, host lists, private networks). Used for the initial URL and
	 * for every redirect hop.
	 *
	 * The DNS check is a pre-flight only: DNS rebinding between this check and the actual
	 * connection remains a residual risk that needs network-level egress controls.
	 */
	const isUrlAllowed = async (url: URL, isRedirectHop: boolean): Promise<boolean> => {
		if (!options.allowedProtocols.includes(url.protocol)) return false
		if (url.protocol === 'file:') {
			// Redirects can never lead to file: URLs; direct file: URLs have no host to check.
			return !isRedirectHop
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

		const host = normalizeHost(url.hostname)
		if (disallowedHosts.includes(host) || (disallowedHosts.includes('localhost') && host.endsWith('.localhost'))) {
			return false
		}
		if (allowedHosts && !allowedHosts.includes(host)) return false

		if (options.disallowPrivateNetworks && !allowedHosts?.includes(host)) {
			const isIpLiteral = url.hostname.startsWith('[') || parseIPv4(host) !== null
			if (isIpLiteral) {
				if (isPrivateAddress(host)) return false
			} else {
				if (host === 'localhost' || host.endsWith('.localhost')) return false
				if (await resolvesToPrivate(host)) return false
			}
		}
		return true
	}

	const fetchAdapter = Object.assign(
		async (input: RequestInfo, init?: RequestInit) => {
			try {
				await rateLimiter.consume('fetch', 1)
				let urlString: string
				if (typeof input === 'string') {
					urlString = input
				} else if (input instanceof URL) {
					urlString = input.toString()
				} else {
					urlString = input.url
				}
				const parsedUrl = new URL(urlString)

				if (!(await isUrlAllowed(parsedUrl, false))) {
					return getForbiddenResponse()
				}

				// Handle file:// protocol with virtual file system
				if (parsedUrl.protocol === 'file:') {
					if (!options.fs) {
						return getForbiddenResponse()
					}
					const filePath = parsedUrl.pathname
					if (!options.fs.existsSync(filePath)) {
						const res = new Response('', { status: 404, statusText: 'NOT_FOUND' })
						return mapResponse(res)
					}
					const content = options.fs.readFileSync(filePath)
					// memfs `readFileSync` returns `string | Buffer`; `Buffer` is a valid body at runtime
					// but not part of the DOM `BodyInit` type, so normalise it to a `Uint8Array`.
					const body: BodyInit = typeof content === 'string' ? content : new Uint8Array(content)
					const res = new Response(body, { status: 200, statusText: 'OK' })
					return mapResponse(res)
				}

				// Only an explicit allowlist of guest-controlled fields reaches host fetch. Anything else
				// (runtime-specific options such as `unix`, `proxy`, `tls`, `dispatcher`, a guest `signal`)
				// is dropped.
				const guestRedirect = init?.redirect
				const redirectMode: 'error' | 'manual' | 'follow' =
					guestRedirect === 'manual' || guestRedirect === 'follow' ? guestRedirect : 'error'
				const signal = AbortSignal.timeout(options.timeout)
				const nativeRequest = typeof Request !== 'undefined' && input instanceof Request ? input : undefined

				const safeInit: RequestInit = { redirect: redirectMode === 'follow' ? 'manual' : redirectMode, signal }
				if (init?.method !== undefined) safeInit.method = init.method
				const headers = normalizeHeadersInit(init?.headers)
				if (headers !== undefined) safeInit.headers = headers
				if (init?.body !== undefined && init?.body !== null) safeInit.body = init.body

				// Forward the validated URL string rather than the raw `input`: a sandbox
				// `Request`-like object arrives as a plain object whose method/headers/body
				// would leak (headers via `_headers`, body ignored). A genuine native
				// `Request` carries those fields on the object, so preserve it (init keys still
				// override it, and `redirect` is always set explicitly).
				// In follow mode the body may have to be replayed on a 307/308 hop. The initial fetch
				// consumes a native Request's body, so buffer it first.
				const nativeBody =
					redirectMode === 'follow' &&
					nativeRequest?.body &&
					safeInit.body === undefined &&
					!['GET', 'HEAD'].includes((safeInit.method ?? nativeRequest.method).toUpperCase())
						? await nativeRequest.clone().arrayBuffer()
						: undefined
				let res = await fetch(nativeRequest ?? urlString, safeInit)

				if (redirectMode === 'follow') {
					// Follow redirects ourselves so that every hop is validated.
					let currentUrl = parsedUrl
					let method = (safeInit.method ?? nativeRequest?.method ?? 'GET').toUpperCase()
					const hopHeaders = new Headers(safeInit.headers ?? nativeRequest?.headers)
					let body: BodyInit | null | undefined = safeInit.body ?? nativeBody
					let hops = 0
					while (REDIRECT_STATUSES.has(res.status)) {
						const location = res.headers.get('location')
						if (!location) break
						if (hops >= MAX_REDIRECTS) {
							await res.body?.cancel()
							throw new Error('Too many redirects')
						}
						hops++
						const nextUrl = new URL(location, currentUrl)
						await res.body?.cancel()
						if (!(await isUrlAllowed(nextUrl, true))) {
							return getForbiddenResponse()
						}
						if (
							res.status === 303 ? method !== 'HEAD' : (res.status === 301 || res.status === 302) && method === 'POST'
						) {
							method = 'GET'
							body = undefined
							for (const name of BODY_HEADERS) hopHeaders.delete(name)
						}
						if (nextUrl.origin !== currentUrl.origin) {
							for (const name of SENSITIVE_HEADERS_ON_CROSS_ORIGIN) hopHeaders.delete(name)
						}
						currentUrl = nextUrl
						const hopInit: RequestInit = { method, headers: hopHeaders, redirect: 'manual', signal }
						if (body !== undefined && body !== null) hopInit.body = body
						res = await fetch(currentUrl.toString(), hopInit)
					}
				}

				// Enforce CORS policy if needed
				if (options.corsCheck) {
					const origin = res.headers.get('Access-Control-Allow-Origin')
					if (!origin || (!options.allowedCorsOrigins.includes('*') && !options.allowedCorsOrigins.includes(origin))) {
						return getForbiddenResponse()
					}
				}

				return mapResponse(res)
			} catch (err) {
				if (err instanceof Error) {
					console.error('Fetch adapter error:', err)
					const res = new Response('', { status: 500, statusText: 'INTERNAL SERVER ERROR' })
					return mapResponse(res)
				}
				const res = new Response('', { status: 429, statusText: 'TOO MANY REQUESTS' })
				return mapResponse(res)
			}
		},
		{
			// Dummy implementation of preconnect for Bun compatibility
			preconnect: async (_url: string | URL, _options?: any) => {
				return
			},
		},
	)

	return fetchAdapter as typeof fetch
}
