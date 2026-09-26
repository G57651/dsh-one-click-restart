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
import { dirname, join } from 'node:path'

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

const outputs = Object.fromEntries(result.outputFiles.map(file => [file.path.split('/').pop(), file.text]))
const body = outputs['client.js'].replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*\s*$/, '')

// The factory body esbuild assumes: a CommonJS scope providing `module` and
// `exports`. Line offsets: the map covers the body starting at line 1; the
// wrapper shifts it down by `before.length` lines, so pad the body with that
// many blank lines to keep the map aligned.
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

const script = [...before, body.padStart(before.length, '\n'), ...after].join('\n') + '\n'
await writeFile(join(pkgRoot, 'lib/client.js'), script)
await writeFile(join(pkgRoot, 'lib/client.js.map'), outputs['client.js.map'])
console.log(`client bundle written: lib/client.js (${script.length} bytes)`)
