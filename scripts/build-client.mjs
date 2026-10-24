/**
 * Build the browser bundle (lib/client.js) served by the host's
 * `/plugins/<pkg>/client.js` route.
 *
 * The client-modules system loads plugin bundles as closure factories:
 * the artifact calls `window.__ModuleLoader__.load({ id, factory })` and the
 * factory receives a `require` resolving externals from the loader module
 * table (react + react/jsx-runtime are platform seed modules). esbuild emits
 * exactly the CJS body that factory shape expects — it only needs the wrapper.
 *
 * Externals policy mirrors the official preset: specifiers answerable from the
 * module table stay `require`s, everything else inlines (this plugin has no
 * other runtime deps; the @deepseek-ai client packages are type-only imports).
 */
import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const pkg = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'))

const result = await build({
  entryPoints: [join(pkgRoot, 'src/client/index.tsx')],
  outfile: 'client.js',
  write: false,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'react',
  sourcemap: 'external',
  sourcesContent: true,
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis'],
  logLevel: 'info',
})

// esbuild reports absolute paths with the platform separator, so split on
// `basename` rather than on '/' (a POSIX-only assumption that leaves Windows
// builds with the whole path as the key and no 'client.js' entry).
const outputs = Object.fromEntries(result.outputFiles.map(file => [basename(file.path), file.text]))
const body = outputs['client.js'].replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*\s*$/, '')

/**
 * Shift a source map down by `lines`, for the wrapper the artifact places above
 * the bundle body. esbuild's map indexes the body from line 1; the closure the
 * loader expects puts that body after `before.length` wrapper lines, so every
 * mapping (and the map's own `mappings` row count) moves by the same offset.
 * Blank-line padding cannot substitute: `padStart` pads to a total LENGTH, so
 * on any real bundle it is a silent no-op and the map silently drifts.
 *
 * @param raw - esbuild's `client.js.map` text.
 * @param lines - wrapper line count to add to every mapping.
 * @returns the shifted map, ready to write beside the bundle.
 */
function shiftMap(raw, lines) {
  const map = JSON.parse(raw)
  if (lines > 0 && map.mappings.length > 0) {
    const padding = ';'.repeat(lines)
    map.mappings = padding + map.mappings
  }
  return JSON.stringify(map)
}

// The factory body esbuild assumes: a CommonJS scope providing `module` and
// `exports`. The wrapper shifts it down by `before.length` lines, which
// `shiftMap` accounts for in the emitted map.
const before = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(pkg.name)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
]
const after = [
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '//# sourceMappingURL=client.js.map',
]

const script = [...before, body, ...after].join('\n') + '\n'
await writeFile(join(pkgRoot, 'lib/client.js'), script)
await writeFile(join(pkgRoot, 'lib/client.js.map'), shiftMap(outputs['client.js.map'], before.length))
console.log(`client bundle written: lib/client.js (${script.length} bytes)`)
