import type { QuickJSAsyncContext, QuickJSContext } from 'quickjs-emscripten-core'
import type { default as TS } from 'typescript'
import type { SandboxAsyncOptions, SandboxOptions } from './SandboxOptions.js'

/** Compiler options accepted by `transpileFile`. Optional `typescript` type; never constructed here. */
type TranspileCompilerOptions = TS.CompilerOptions

export type CodeFunctionInput = {
	ctx: QuickJSContext
	sandboxOptions: SandboxOptions
	// Matches the returned `transpileFile` (ts.transpile-compatible). We only ever call it as
	// `transpileFile(code, undefined, fileName)`; the middle arg stays for signature parity.
	transpileFile: (input: string, compilerOptions?: TranspileCompilerOptions, fileName?: string) => string
	remapStack: (stack: string) => string
}

export type CodeFunctionAsyncInput = {
	ctx: QuickJSAsyncContext
	sandboxOptions: SandboxAsyncOptions
	// Matches the returned `transpileFile` (ts.transpile-compatible). We only ever call it as
	// `transpileFile(code, undefined, fileName)`; the middle arg stays for signature parity.
	transpileFile: (input: string, compilerOptions?: TranspileCompilerOptions, fileName?: string) => string
	remapStack: (stack: string) => string
}
