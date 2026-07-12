import { join } from 'node:path'
import type { IFs, NestedDirectoryJSON } from 'memfs'
import type { default as TS } from 'typescript'
import { type DecodedMappings, originalPositionFor, parseMappings } from './sandbox/sourceMap.js'

export type TranspileNestedJsonOptions = {
	fileExtensions?: string[]
}

export type TranspileVirtualFsOptions = {
	fileExtensions?: string[]
	startPath?: string
}

/**
 * Matches a stack frame's location: `(<file>:<line>[:<col>])`.
 * QuickJS guest frames look like `    at handler (/src/script:6:15)`. Host frames appended
 * after a `Host:` marker point at real filesystem paths and simply won't have a stored map,
 * so this same rewrite leaves them untouched.
 */
const STACK_FRAME_LOCATION = /\(([^()]+?):(\d+)(?::(\d+))?\)/g

/** No-op stack remapper used when TypeScript support is disabled. */
const identityRemapStack = (stack: string): string => stack

/**
 * Add support for handling typescript files and code.
 * Requires the optional dependency 'typescript'.
 */
export const getTypescriptSupport = async (
	enabled = false,
	typescriptImportFile?: string,
	options?: TS.CompilerOptions,
) => {
	if (!enabled) {
		return {
			transpileFile: (
				value: string,
				_compilerOptions?: TS.CompilerOptions,
				_fileName?: string,
				_diagnostics?: TS.Diagnostic[],
				_moduleName?: string,
			) => value,
			transpileNestedDirectoryJSON: (
				mountFsJson: NestedDirectoryJSON,
				_option?: TranspileNestedJsonOptions,
			): NestedDirectoryJSON => mountFsJson,
			transpileVirtualFs: (fs: IFs, _options?: TranspileVirtualFsOptions): IFs => {
				return fs
			},
			remapStack: identityRemapStack,
		}
	}

	let ts: typeof TS
	try {
		ts = await import(typescriptImportFile ?? 'typescript')
	} catch (_error) {
		throw new Error('Package "typescript" is missing')
	}

	const compilerOptions: TS.CompilerOptions = {
		module: 99, // ESNext
		target: 99, // ES2023
		//lib: ['ESNext'],
		allowJs: true,
		// moduleResolution: 100,
		skipLibCheck: true,
		esModuleInterop: true,
		strict: false,
		allowSyntheticDefaultImports: true,
		// Emit a source map so we can translate emitted-JS stack positions back to the
		// original `.ts` source. Kept separate (not inline) — we consume it in-process.
		sourceMap: true,
		inlineSourceMap: false,
		...options,
	}

	/**
	 * Decoded source maps for this `getTypescriptSupport` call, keyed by the virtual path
	 * QuickJS reports in stack frames (e.g. `/src/script`). Created fresh per call, so it is
	 * scoped to the `runSandboxed` call and garbage-collected with it — nothing to dispose.
	 */
	const sourceMaps = new Map<string, DecodedMappings>()

	// TypeScript with `sourceMap: true` appends this comment to the emitted JS; strip it so
	// it never leaks into the mounted/eval'd guest code.
	const SOURCE_MAP_URL_COMMENT = /\n?\/\/# sourceMappingURL=.*\s*$/

	/**
	 * Register a decoded source map under a virtual path. The key is normalized to how
	 * QuickJS reports the file in stack frames: user files are mounted without an extension
	 * (e.g. `/src/script`), so we store both the extension-less path and the `.js` variant.
	 */
	const registerSourceMap = (virtualPath: string, sourceMapText: string | undefined): void => {
		if (!sourceMapText) {
			return
		}
		try {
			const map = JSON.parse(sourceMapText) as { mappings?: string }
			if (!map.mappings) {
				return
			}
			const decoded = parseMappings(map.mappings)
			sourceMaps.set(virtualPath, decoded)
			const withoutJs = virtualPath.replace(/\.js$/, '')
			if (withoutJs !== virtualPath) {
				sourceMaps.set(withoutJs, decoded)
			}
		} catch {
			// A malformed map must never break transpilation; just skip remapping this file.
		}
	}

	/**
	 * Transpile TypeScript to JavaScript and, when a `fileName` is given, register the
	 * emitted source map under that virtual path for later stack remapping.
	 *
	 * @returns javascript code (with the trailing sourceMappingURL comment stripped)
	 */
	const transpileWithMap = (input: string, fileName?: string): string => {
		const out = ts.transpileModule(input, { compilerOptions, fileName })
		if (fileName) {
			registerSourceMap(fileName, out.sourceMapText)
		}
		return out.outputText.replace(SOURCE_MAP_URL_COMMENT, '')
	}

	/**
	 * Transpile a single File.
	 *
	 * Keeps the `ts.transpile`-compatible signature (string in, string out) so existing
	 * callers are unaffected. When a `fileName` is supplied, the emitted source map is
	 * captured so stack frames pointing at that path can be remapped to the original source.
	 *
	 * @param input source typescript code
	 * @returns javascript code
	 */
	const transpileFile: typeof ts.transpile = (
		input: string,
		_cpOptions = compilerOptions,
		fileName?: string,
		_diagnostics?: TS.Diagnostic[],
		_moduleName?: string,
	) => transpileWithMap(input, fileName)

	/**
	 * Rewrite each guest stack frame's line/column back to the original TypeScript source
	 * using the maps captured during transpilation. Frames whose file has no stored map
	 * (the entry wrapper, node_modules, and the appended `Host:` frames) pass through
	 * unchanged. Never throws on an empty or absent stack.
	 */
	const remapStack = (stack: string): string => {
		if (!stack || sourceMaps.size === 0) {
			return stack
		}
		return stack.replace(STACK_FRAME_LOCATION, (whole, file: string, line: string, col?: string) => {
			const mappings = sourceMaps.get(file)
			if (!mappings) {
				return whole
			}
			const pos = originalPositionFor(mappings, Number(line), col ? Number(col) : 0)
			if (!pos) {
				return whole
			}
			return `(${file}:${pos.line}:${pos.column})`
		})
	}

	/**
	 * Iterates through the given JSON - NestedDirectoryJSON for defining the virtual file system.
	 * Replace every typescript file with the transpiled javascript version and renames the file to *.js
	 *
	 * @param mountFsJson
	 * @param fileExtensions
	 * @returns
	 */
	const transpileNestedDirectoryJSON = (
		mountFsJson: NestedDirectoryJSON,
		option?: TranspileNestedJsonOptions,
	): NestedDirectoryJSON => {
		const opt = {
			fileExtensions: ['ts'],
			...option,
		}

		const transformJson = (
			obj: NestedDirectoryJSON,
			transformer: (key: string, value: any) => [string, any],
		): NestedDirectoryJSON => {
			if (typeof obj === 'object' && obj !== null) {
				const newObj: any = Array.isArray(obj) ? [] : {}
				for (const key in obj) {
					if (obj[key]) {
						const [newKey, newValue] = transformer(key, obj[key])
						newObj[newKey] = transformJson(newValue, transformer)
					}
				}
				return newObj
			}
			return obj
		}

		const transpileTypescript = (key: string, value: string | Buffer): [string, any] => {
			if (!opt.fileExtensions.includes(key)) {
				return [key, value]
			}
			const newFileName = key.replace('.ts', '.js')
			const tsSource = typeof value === 'string' ? value : value.toString()
			const jsSource = transpileFile(tsSource, compilerOptions)
			return [newFileName, jsSource]
		}

		return transformJson(mountFsJson, transpileTypescript)
	}

	const transpileVirtualFs = (fs: IFs, options?: TranspileVirtualFsOptions) => {
		const opt = {
			startPath: '/src',
			...options,
		}

		const transformFileSystem = (startPath: string): void => {
			if (!fs.existsSync(startPath)) {
				throw new Error(`Directory not found: ${startPath}`)
			}

			const files = fs.readdirSync(startPath)
			for (const file of files) {
				const filePath = join(startPath, file as string)
				const stat = fs.lstatSync(filePath)

				if (stat.isDirectory()) {
					// ignore node_modules
					if ((file as string) !== 'node_modules') {
						transformFileSystem(filePath)
					}
				} else if (stat.isFile()) {
					const newFilePath = join(startPath, (file as string).replace('.ts', '.js'))
					const content = fs.readFileSync(filePath, 'utf8')
					const tsSource = typeof content === 'string' ? content : content.toString()
					const jsSource = transpileFile(tsSource, compilerOptions, newFilePath)
					fs.renameSync(filePath, newFilePath)
					fs.writeFileSync(newFilePath, jsSource)
				}
			}
		}

		transformFileSystem(opt.startPath)

		return fs
	}

	return { transpileFile, transpileNestedDirectoryJSON, transpileVirtualFs, remapStack }
}
