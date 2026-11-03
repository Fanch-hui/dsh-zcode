import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const result = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/index.tsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'zod', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'],
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
})
await mkdir(new URL('../lib/', import.meta.url), { recursive: true })
await writeFile(new URL('../lib/client.js', import.meta.url), result.outputFiles[0].contents)
