/** Load the server's model-request verification configuration. */
import { shutdownCaptchaSolver } from "./captcha-solver.js";

const CAPTCHA_HEADER = "x-aliyun-captcha-verify-param";
const REGION_HEADER = "x-aliyun-captcha-verify-region";
const CONFIGS_API = "https://zcode.z.ai/api/v1/client/configs";

interface FetchedCaptchaConfig { enabled: boolean; prefix: string; sceneId: string; region: string; skip_model_request?: boolean; }
// Config snapshot — mirrors the real client's host `getClientConfigs`
// (3.16.3 codingPlanSubscription): 1h TTL (`RRe=3600*1e3`), 15s timeout
// (`Js=15e3`), in-flight request dedup, and NO negative cache — a failed
// response said (absent captcha field included); only SUCCESSFUL fetches
// write it (§H 十轮; the old 60s TTL + 15s neg-cache was self-invented
// cadence refreshing 60× more often than the real client, and it manufactured
// the #002 "Captcha config unavailable" storm).
let cachedConfig: { value: FetchedCaptchaConfig | null; expiresAt: number } = { value: null, expiresAt: 0 };
let configsFetchInFlight: Promise<FetchedCaptchaConfig | null> | null = null;
// Keep the last authoritative config during temporary fetch outages.
let lastGoodCfg: FetchedCaptchaConfig | null = null;

type ConfigsFetch = typeof fetch;
let configsFetch: ConfigsFetch | null = null;
/** Test seam for the configs fetch — production code never calls this. */
export function __setConfigsFetchForTests(impl: ConfigsFetch | null): void {
  configsFetch = impl;
}

/** Test seam: clear the config caches — tests only. `keepLastGood` preserves
 *  the outage-fallback config (simulates snapshot expiry mid-outage). */
export function __resetCaptchaConfigCacheForTests(keepLastGood = false): void {
  cachedConfig = { value: null, expiresAt: 0 };
  configsFetchInFlight = null;
  if (!keepLastGood) lastGoodCfg = null;
}

export function detectCaptchaChallenge(resp: Response): string | null {
  const v = resp.headers.get(CAPTCHA_HEADER);
  return v && v.trim().length > 0 ? v.trim() : null;
}


async function fetchCaptchaConfig(appVersion: string): Promise<FetchedCaptchaConfig | null> {
  if (cachedConfig.expiresAt > Date.now()) return cachedConfig.value;
  if (configsFetchInFlight) return configsFetchInFlight;
  configsFetchInFlight = (async () => {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bound the entire fetch, including the body. A response that sends
      // headers but stalls its JSON must not pin the shared in-flight promise.
      // Override: CAPTCHA_CONFIG_TIMEOUT_MS (mirror timeout 15s).
      const rawTimeoutMs = Number(process.env.CAPTCHA_CONFIG_TIMEOUT_MS || 15_000);
      const cfgTimeoutMs = Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0 ? rawTimeoutMs : 15_000;
      const readConfig = async (): Promise<unknown> => {
        const platform = `${process.platform}-${process.arch}`;
        const resp = await (configsFetch ?? fetch)(`${CONFIGS_API}?app_version=${encodeURIComponent(appVersion)}&platform=${encodeURIComponent(platform)}`, { signal: controller.signal });
        if (!resp.ok || controller.signal.aborted) {
          void resp.body?.cancel().catch(() => {});
          throw new Error(`Captcha config request failed (${resp.status})`);
        }
        reader = resp.body?.getReader();
        const chunks: Uint8Array[] = [];
        try {
          if (reader) {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
          }
          return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
        } finally {
          reader?.releaseLock();
          reader = undefined;
        }
      };
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Captcha config request timed out"));
          controller.abort();
          void reader?.cancel().catch(() => {});
        }, cfgTimeoutMs);
      });
      const json = (await Promise.race([readConfig(), timeout])) as { data?: { configs?: { captcha?: FetchedCaptchaConfig } } };
      const cfg = json?.data?.configs?.captcha ?? null;
      // Snapshot write ONLY on a successful fetch (mirror: failures never
      // update the snapshot — the next call retries immediately).
      cachedConfig = { value: cfg, expiresAt: Date.now() + captchaConfigTtlMs() };
      if (cfg) lastGoodCfg = cfg;
      return cfg;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      configsFetchInFlight = null;
    }
  })();
  return configsFetchInFlight;
}

/** Snapshot TTL — mirror `RRe = 3600*1e3`. Override: CAPTCHA_CONFIG_TTL_MS. */
function captchaConfigTtlMs(): number {
  const raw = Number(process.env.CAPTCHA_CONFIG_TTL_MS || 3_600_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 3_600_000;
}

/** Only allow model requests when the platform has disabled their verification. */
export async function getCaptchaToken(appVersion: string): Promise<{ verifyParam: string; region: string } | null> {
  const cfg = (await fetchCaptchaConfig(appVersion)) ?? lastGoodCfg;
  if (!cfg) throw new Error("Captcha config unavailable");
  if (!cfg.enabled || cfg.skip_model_request === true) return null;
  throw new Error("VERIFICATION_REQUIRED");
}

export function shutdownCaptcha(): void {
  try { shutdownCaptchaSolver(); } catch {}
}

export function noteDemand(): void {}

/** Check the model verification setting without starting a token pool. */
export async function startCaptchaPool(appVersion: string): Promise<void> {
  const cfg = await fetchCaptchaConfig(appVersion);
  if (!cfg || !cfg.enabled || cfg.skip_model_request === true) return;
  throw new Error("VERIFICATION_REQUIRED");
}

export const RETRY_HEADERS = { PARAM: CAPTCHA_HEADER, REGION: REGION_HEADER };
