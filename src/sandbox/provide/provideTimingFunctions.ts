import { type QuickJSAsyncContext, type QuickJSContext, type QuickJSHandle, Scope } from 'quickjs-emscripten-core'

type Timer = {
	id: ReturnType<typeof setTimeout>
	callback: QuickJSHandle
	args: QuickJSHandle[]
	ownership: Scope
	active: boolean
	running: boolean
}

export const provideTimingFunctions = (
	ctx: QuickJSContext | QuickJSAsyncContext,
	max: {
		maxTimeoutCount: number
		maxIntervalCount: number
	},
) => {
	const scope = new Scope()
	const timeouts = new Map<number, Timer>()
	const immediates = new Map<number, Timer>()
	const intervals = new Map<number, Timer>()
	let counter = 0
	let disposed = false
	let reportFailure!: (error: Error) => void
	// Resolves with the first callback failure. Ignoring it at the provider level does
	// not create an unhandled host rejection; evaluators race it against their result.
	const failure = new Promise<Error>(resolve => {
		reportFailure = resolve
	})
	const report = (value: unknown) => {
		if (disposed || !ctx.alive) return
		if (value instanceof Error) {
			reportFailure(value)
			return
		}
		const details =
			value && typeof value === 'object' ? (value as { message?: unknown; name?: unknown; stack?: unknown }) : undefined
		const error = new Error(details?.message !== undefined ? String(details.message) : String(value))
		if (typeof details?.name === 'string') error.name = details.name
		if (typeof details?.stack === 'string') error.stack = details.stack
		reportFailure(error)
	}
	const reporter = scope.manage(
		ctx.newFunction('timerFailure', value => {
			if (!disposed && ctx.alive) report(ctx.dump(value))
		}),
	)
	const watch = scope.manage(
		ctx.unwrapResult(
			ctx.evalCode(`(value, report) => {
				if (value && typeof value.then === 'function') Promise.resolve(value).then(undefined, report)
			}`),
		),
	)
	const release = (timer: Timer) => {
		if (!timer.running && timer.ownership.alive) timer.ownership.dispose()
	}
	const cancel = (timers: Map<number, Timer>, id: number) => {
		const timer = timers.get(id)
		if (!timer) return
		timers.delete(id)
		timer.active = false
		clearTimeout(timer.id)
		clearInterval(timer.id)
		release(timer)
	}
	const invoke = (timers: Map<number, Timer>, id: number, repeat: boolean) => {
		const timer = timers.get(id)
		if (!timer?.active || disposed || !ctx.alive) return
		if (!repeat) {
			timers.delete(id)
			timer.active = false
		}
		timer.running = true
		try {
			const result = ctx.callFunction(timer.callback, ctx.undefined, ...timer.args)
			try {
				if (result.error) report(ctx.dump(result.error))
				else if (!disposed && ctx.alive) {
					const observed = ctx.callFunction(watch, ctx.undefined, result.value, reporter)
					try {
						if (observed.error) report(ctx.dump(observed.error))
					} finally {
						observed.dispose()
					}
				}
			} finally {
				result.dispose()
			}
		} catch (error) {
			report(error)
		} finally {
			timer.running = false
			if (!timer.active) release(timer)
		}
	}
	const register = (name: string, timers: Map<number, Timer>, repeat = false) => {
		const set = scope.manage(
			ctx.newFunction(name, (callback, delay, ...extraArgs) => {
				if (disposed) throw new Error('Timer provider has been disposed')
				const limit = repeat ? max.maxIntervalCount : max.maxTimeoutCount
				if (timers.size >= limit) {
					throw new Error(
						`Client tries to use ${name}, which exceeds the limit of max ${limit} concurrent running timer functions`,
					)
				}
				if (!callback || ctx.typeof(callback) !== 'function') throw new TypeError(`${name} callback must be a function`)
				const timeout = name === 'setImmediate' ? 0 : delay ? ctx.dump(delay) : undefined
				const ownership = new Scope()
				const id = counter++
				try {
					const copy = ownership.manage(callback.dup())
					const params = name === 'setImmediate' ? (delay ? [delay, ...extraArgs] : []) : extraArgs
					const args = params.map(arg => ownership.manage(arg.dup()))
					const hostId = repeat
						? setInterval(() => invoke(timers, id, true), timeout)
						: setTimeout(() => invoke(timers, id, false), timeout)
					timers.set(id, { id: hostId, callback: copy, args, ownership, active: true, running: false })
					return ctx.newNumber(id)
				} catch (error) {
					cancel(timers, id)
					if (ownership.alive) ownership.dispose()
					throw error
				}
			}),
		)
		ctx.setProp(ctx.global, name, set)
		const clearName = name.replace('set', 'clear')
		const clear = scope.manage(
			ctx.newFunction(clearName, handle => {
				if (!handle) return
				const id = ctx.dump(handle)
				for (const map of [timeouts, immediates, intervals]) cancel(map, id)
			}),
		)
		ctx.setProp(ctx.global, clearName, clear)
	}
	register('setTimeout', timeouts)
	register('setImmediate', immediates)
	register('setInterval', intervals, true)

	const dispose = () => {
		if (disposed) return
		disposed = true
		for (const timers of [timeouts, immediates, intervals]) {
			for (const id of timers.keys()) cancel(timers, id)
		}
		scope.dispose()
	}

	const executePendingJobs = () => {
		if (disposed || !ctx.alive) return
		try {
			const result = ctx.runtime.executePendingJobs()
			try {
				if (result.error) report(result.error.context.dump(result.error))
			} finally {
				result.dispose()
			}
		} catch (error) {
			report(error)
		}
	}

	return { dispose, failure, executePendingJobs }
}
