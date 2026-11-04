const CONTROL_TIMEOUT_MS = 15_000

export function controlFetch(fetcher: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const signals = [AbortSignal.timeout(CONTROL_TIMEOUT_MS)]
    if (input instanceof Request) signals.push(input.signal)
    if (init?.signal) signals.push(init.signal)
    return fetcher(input, { ...init, signal: AbortSignal.any(signals) })
  }
}
