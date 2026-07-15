import type { IFs } from 'memfs'
import { RateLimiterMemory } from 'rate-limiter-flexible'

const DISALLOW_HOSTS_DEFAULT = ['localhost', '127.0.0.1']
const DEFAULT_TIMEOUT = 5000 // 5 seconds
const DEFAULT_RATE_LIMIT_POINTS = 10 // Number of requests
const DEFAULT_RATE_LIMIT_DURATION = 1 // Per second

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

/**
 * Create a default fetch adapter
 * @param adapterOptions Options for creating the fetch adapter
 * @returns A fetch adapter function
 */
export const getDefaultFetchAdapter = (adapterOptions: GetFetchAdapterOptions = {}): typeof fetch => {
	const options = {
		allowedProtocols: ['http:', 'https:'],
		disallowedHosts: adapterOptions.disallowedHosts ?? DISALLOW_HOSTS_DEFAULT,
		timeout: adapterOptions.timeout ?? DEFAULT_TIMEOUT,
		corsCheck: adapterOptions.corsCheck ?? false,
		allowedCorsOrigins: adapterOptions.allowedCorsOrigins ?? ['*'],
		rateLimitPoints: adapterOptions.rateLimitPoints ?? DEFAULT_RATE_LIMIT_POINTS,
		rateLimitDuration: adapterOptions.rateLimitDuration ?? DEFAULT_RATE_LIMIT_DURATION,
		...adapterOptions,
	}

	const rateLimiter = new RateLimiterMemory({
		points: options.rateLimitPoints,
		duration: options.rateLimitDuration,
	})

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

				// Check disallowed hosts
				if (options.disallowedHosts.includes(parsedUrl.hostname)) {
					return getForbiddenResponse()
				}

				// Check allowed hosts
				if (options.allowedHosts && !options.allowedHosts.includes(parsedUrl.hostname)) {
					return getForbiddenResponse()
				}

				// Check allowed protocols
				if (!options.allowedProtocols.includes(parsedUrl.protocol)) {
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

				// Setup request with timeout
				const initWithDefaults: RequestInit = {
					redirect: 'error',
					...init,
					headers: normalizeHeadersInit(init?.headers),
					signal: AbortSignal.timeout(options.timeout),
				}

				// Forward the validated URL string rather than the raw `input`: a sandbox
				// `Request`-like object arrives as a plain object whose method/headers/body
				// would leak (headers via `_headers`, body ignored). A genuine native
				// `Request` carries those fields on the object, so preserve it as-is.
				const fetchInput = typeof Request !== 'undefined' && input instanceof Request ? input : urlString
				const res = await fetch(fetchInput, initWithDefaults)

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
