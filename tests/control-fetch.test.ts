import assert from 'node:assert/strict'
import test from 'node:test'
import { controlFetch } from '../integration/control-fetch.js'

test('control requests retain caller cancellation and a 15 second deadline', async () => {
  const originalTimeout = AbortSignal.timeout
  const deadlines: AbortController[] = []
  AbortSignal.timeout = milliseconds => {
    assert.equal(milliseconds, 15_000)
    const deadline = new AbortController()
    deadlines.push(deadline)
    return deadline.signal
  }
  try {
    const signals: AbortSignal[] = []
    const bounded = controlFetch(async (_input, init) => {
      signals.push(init!.signal!)
      return new Response()
    })
    const requestAbort = new AbortController()
    const callerAbort = new AbortController()
    const request = new Request('https://example.test/', { signal: requestAbort.signal })
    await bounded(request, { signal: callerAbort.signal })
    callerAbort.abort()
    assert.equal(signals[0].aborted, true)

    const second = new Request('https://example.test/', { signal: requestAbort.signal })
    await bounded(second)
    requestAbort.abort()
    assert.equal(signals[1].aborted, true)

    await bounded('https://example.test/')
    deadlines[2].abort()
    assert.equal(signals[2].aborted, true)
  } finally {
    AbortSignal.timeout = originalTimeout
  }
})
