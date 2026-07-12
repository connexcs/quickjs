import type { ErrorResponse } from '../types/ErrorResponse.js'

/**
 * @param err the thrown value
 * @param remapStack optional stack rewriter that translates emitted-JS positions back to
 *   the original TypeScript source. Applied to `Error.stack` only; safe to omit.
 */
export const handleEvalError = (err: unknown, remapStack?: (stack: string) => string): ErrorResponse => {
	return err instanceof Error
		? {
				ok: false,
				error: {
					name: err.name,
					message: err.message,
					stack: remapStack && err.stack ? remapStack(err.stack) : err.stack,
				},
				isSyntaxError: err.name === 'SyntaxError',
			}
		: {
				ok: false,
				error: {
					name: 'UnknownError',
					message: typeof err === 'string' ? err : 'An unknown error occurred.',
					stack: '',
				},
				isSyntaxError: false,
			}
}
