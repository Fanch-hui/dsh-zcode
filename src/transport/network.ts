import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'

export function createNetwork() {
  const dispatcher = new EnvHttpProxyAgent({ connections: 8, pipelining: 1, bodyTimeout: 0 })
  const fetcher: typeof fetch = async (input, init) => {
    return await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init, dispatcher, redirect: 'error',
    } as Parameters<typeof undiciFetch>[1]) as unknown as Response
  }
  return { fetch: fetcher, dispose: () => dispatcher.destroy() }
}
