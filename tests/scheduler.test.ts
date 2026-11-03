import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { RequestScheduler } from '../src/transport/scheduler.js'

test('schedules sessions fairly, keeps accounts independent, and releases each slot once', async () => {
  const scheduler = new RequestScheduler()
  const active = await scheduler.acquire('account', 'A', 1)
  const order: string[] = []
  const enqueue = (session: string, name: string) => scheduler.acquire('account', session, 1).then(release => {
    order.push(name); release(); release()
  })
  const pending = [enqueue('A', 'A2'), enqueue('A', 'A3'), enqueue('B', 'B1'), enqueue('B', 'B2')]
  const other = await scheduler.acquire('other', 'C', 1)
  other()
  assert.deepEqual(order, [])
  active()
  await Promise.all(pending)
  assert.deepEqual(order, ['A2', 'B1', 'A3', 'B2'])
  scheduler.dispose()
})

test('cancels a queued session without consuming another slot and rejects queued work on disposal', async () => {
  const scheduler = new RequestScheduler()
  const active = await scheduler.acquire('account', 'A', 1)
  const controller = new AbortController()
  const cancelled = scheduler.acquire('account', 'B', 1, controller.signal)
  const rejected = assert.rejects(cancelled)
  controller.abort()
  await rejected
  const pending = scheduler.acquire('account', 'C', 1)
  const stopped = assert.rejects(pending)
  scheduler.dispose()
  await stopped
  active()
})

test('applies account cooldown to every queued session', async () => {
  const scheduler = new RequestScheduler()
  const active = await scheduler.acquire('account', 'A', 1)
  scheduler.cooldown('account', 45)
  let started = false
  const pending = scheduler.acquire('account', 'B', 1).then(release => { started = true; release() })
  active()
  await wait(15)
  assert.equal(started, false)
  await wait(50)
  await pending
  assert.equal(started, true)
  scheduler.dispose()
})
