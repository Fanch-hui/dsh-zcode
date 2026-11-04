import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceId } from '../src/storage/device.js'

test('publishes one complete device identity across concurrent runtimes and reuses it after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-zcode-device-'))
  try {
    const first = createDeviceId(directory)
    const second = createDeviceId(directory)
    const values = await Promise.all([first(), first(), second(), createDeviceId(directory)()])
    assert.equal(new Set(values).size, 1)
    assert.match(values[0], /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
    assert.equal(await createDeviceId(directory)(), values[0])
    assert.deepEqual(await readdir(join(directory, '.dsh-zcode')), ['device-id'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
