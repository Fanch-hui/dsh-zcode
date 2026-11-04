import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const outputDirectory = join(root, 'lib/proxy')
const outfile = join(outputDirectory, 'upstream.cjs')
const verification = join(root, 'integration/verification-required.ts')
const upstream = join(root, 'vendor/zcode-api')

const result = await build({
  absWorkingDir: root,
  entryPoints: ['integration/upstream-worker.ts'],
  outfile,
  bundle: true,
  write: false,
  metafile: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.ZCODE_DUMP_UPSTREAM': 'undefined' },
  plugins: [{
    name: 'model-verification-required',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/captcha-solver\.js$/ }, args => {
        if (args.resolveDir !== join(upstream, 'src/proxy')) return
        return { path: verification }
      })
    },
  }],
})

const forbidden = Object.keys(result.metafile.inputs).filter(input =>
  /(?:^|\/)captcha-(?:happy|solver|worker-(?:asset|dispatch|entry))\.[cm]?[jt]s$/u.test(input)
  || /(?:^|\/)node_modules\/happy-dom\//u.test(input),
)
if (forbidden.length > 0) throw new Error(`Unexpected verification implementation in bundle: ${forbidden.join(', ')}`)

const output = Object.values(result.metafile.outputs).find(value => value.entryPoint === 'integration/upstream-worker.ts')
if (!output || result.outputFiles.length !== 1) throw new Error('Unexpected proxy build output')
const packages = new Map()
for (const [input, info] of Object.entries(output.inputs)) {
  if (!info.bytesInOutput || !input.split(/[\\/]/u).includes('node_modules')) continue
  const item = await findPackage(resolve(root, input))
  packages.set(item.root, item)
}

const licenses = [
  'TriDefender/zcode-api, version 4.8.8.android\n',
  'https://github.com/TriDefender/zcode-api\n',
  'Revision: 158e7653b738cbed0996243eeabd26f816638e81\n',
  'Local integration notes:\n',
  (await readFile(join(upstream, 'UPSTREAM.md'), 'utf8')).trim(),
  '\n\n',
  (await readFile(join(upstream, 'LICENSE'), 'utf8')).trim(),
  '\n',
]
for (const item of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
  const files = await readdir(item.root)
  const name = files.find(file => /^licen[cs]e(?:\.[^/]+)?$/iu.test(file))
  if (!name) throw new Error(`Missing license for bundled package ${item.name}@${item.version}`)
  const license = (await readFile(join(item.root, name), 'utf8')).trim()
  licenses.push(`\n${item.name}@${item.version} (${item.license})\n${'-'.repeat(60)}\n${license}\n`)
}

await mkdir(outputDirectory, { recursive: true })
await writeFile(outfile, result.outputFiles[0].contents)
await writeFile(join(outputDirectory, 'THIRD_PARTY_LICENSES.txt'), licenses.join(''))

async function findPackage(input) {
  let directory = dirname(input)
  while (directory !== dirname(directory)) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (manifest.name && manifest.version) return { root: directory, ...manifest }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (directory.endsWith(`${sep}node_modules`)) break
    directory = dirname(directory)
  }
  throw new Error(`Unable to identify package for bundled input: ${input}`)
}
