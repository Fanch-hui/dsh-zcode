import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const outfile = join(root, 'lib/cli/bin.js')
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/cli/bin.ts'],
  outfile,
  bundle: true,
  write: false,
  metafile: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['undici', 'zod'],
  // Some bundled CommonJS dependencies load Node builtins through require().
  banner: { js: "import { createRequire as __cliCreateRequire } from 'node:module'; const require = __cliCreateRequire(import.meta.url);" },
})

const output = Object.values(result.metafile.outputs)[0]
const packages = new Map()
for (const [input, info] of Object.entries(output.inputs)) {
  if (!info.bytesInOutput || !input.split(/[\\/]/u).includes('node_modules')) continue
  const item = await findPackage(resolve(root, input))
  packages.set(item.root, item)
}

const licenses = ['Licenses for dependencies bundled in lib/cli/bin.js.\n']
for (const item of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
  const files = await readdir(item.root)
  const name = files.find(file => /^licen[cs]e(?:\.[^/]+)?$/iu.test(file))
  if (!name) throw new Error(`Missing license for bundled package ${item.name}@${item.version}`)
  const license = (await readFile(join(item.root, name), 'utf8')).trim()
  licenses.push(`\n${item.name}@${item.version} (${item.license})\n${'-'.repeat(60)}\n${license}\n`)
}

await mkdir(dirname(outfile), { recursive: true })
await writeFile(outfile, result.outputFiles[0].contents)
await writeFile(join(dirname(outfile), 'THIRD_PARTY_LICENSES.txt'), licenses.join(''))

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
