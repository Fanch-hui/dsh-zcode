import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function missing(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

async function readIdentity(file: string): Promise<string> {
  const identity = (await readFile(file, 'utf8')).trim()
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(identity)) {
    throw new Error('ZCode 设备身份文件格式无效。')
  }
  return identity
}

async function loadIdentity(directory: string): Promise<string> {
  const folder = join(directory, '.dsh-zcode')
  const file = join(folder, 'device-id')
  try { return await readIdentity(file) }
  catch (error) { if (!missing(error, 'ENOENT')) throw error }
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const temporary = join(folder, `${randomUUID()}.tmp`)
  await writeFile(temporary, `${randomUUID()}\n`, { flag: 'wx', mode: 0o600 })
  try {
    try { await link(temporary, file) }
    catch (error) { if (!missing(error, 'EEXIST')) throw error }
    return await readIdentity(file)
  } finally { await unlink(temporary) }
}

export function createDeviceId(directory: string): () => Promise<string> {
  let pending: Promise<string> | undefined
  return () => {
    pending ??= loadIdentity(directory).catch(error => { pending = undefined; throw error })
    return pending
  }
}
