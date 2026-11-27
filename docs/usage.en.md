# DSH ZCode usage and development notes

**[简体中文](usage.md) | English | [Русский](usage.ru.md)**

This file keeps the complete installation, usage, CLI, headless and development notes; it is not distributed with the plugin package. The DSH plugin details page shows the plugin summary from [README.en.md](../README.en.md).

Use BigModel and Z.AI Coding Plan and ZCode Start Plan in DeepSeek Harness through [TriDefender/zcode-api](https://github.com/TriDefender/zcode-api).

The plugin bundles the original project's proxy core, pinned at `4.8.8.android`, commit `158e7653b738cbed0996243eeabd26f816638e81`. Login, credential resolution, plan endpoints, request signing, system message organization and upstream forwarding all reuse that core. The DSH adapter layer handles the model catalog and message/stream conversion; tool execution, approvals, sessions and sub-agents are DSH responsibilities.

## Installation and usage

The development baseline is DSH **0.2.2-rc.1**, compatibility range `>=0.2.2-alpha.3 <0.3.0`, Node **24.9.0 or newer**. The desktop app uses its bundled Node.

```bash
dsh plugin --profile desktop add dsh-zcode@0.2.1
```

This installs the plugin from [npm](https://www.npmjs.com/package/dsh-zcode). For an npm-installed DSH, change the profile to `web`.

You can also download the `.tgz` package from [GitHub Releases](https://github.com/Fanch-hui/dsh-zcode/releases), add it as a local file through the desktop plugin manager, or run:

```bash
dsh plugin --profile desktop add ./dsh-zcode-0.2.1.tgz
```

1. Open "Plugins → ZCode" and choose a platform and plan.
2. Click "Sign in" and complete authorization on the official web page. Existing plugin login records are resolved by the proxy core on first use.
3. In the DSH model picker, choose the matching plan, e.g. `ZCode · Z.AI Start Plan`.
4. View quotas on the plugin settings page; click "Refresh" to fetch current usage.

Both plans share the same platform web login. Coding Plan also accepts a manual plan key. Defaults: concurrency 2, output limit 32,000 tokens, request timeout 300 seconds, reasoning effort "High".

## Models and plans

| Model | Input | Context | Max output | Reasoning efforts |
| --- | --- | --- | --- | --- |
| GLM-5.3 | text | 1,000,000 | 128,000 | low / high / max |
| GLM-5.3-Flash | text, image | 1,000,000 | 128,000 | low / high / max |
| GLM-5.2 | text | 1,000,000 | 128,000 | off / high / max |
| GLM-5-Turbo | text | 200,000 | 64,000 | off / on |

The four providers are `zcode-bigmodel`, `zcode-zai`, `zcode-bigmodel-start-plan` and `zcode-zai-start-plan`. The plan and model selection determine the channel used; when the platform returns quota or permission errors, the corresponding state is shown.

The Coding Plan catalog offers GLM-5.3 and GLM-5.3-Flash; the Start Plan catalog offers GLM-5.3-Flash, GLM-5.2, GLM-5-Turbo and GLM-5.3. Each model exposes its own set of reasoning efforts, and output settings follow each model's limits.

Quota queries call the proxy core's `collectQuotaSnapshot`. Start Plan shows model balance buckets; Coding Plan shows plan windows. Queries are cached for 60 seconds; a manual refresh fetches the latest data. Token statistics are converted using DSH's input, cache read, cache write and output accounting.

## Token statistics

"Token statistics" on the settings page tracks model calls made through this plugin per provider and model: each row is a plan/model combination showing call count, total tokens, input, output, cache read and cache hit rate, with a final "Total" row aggregated from the rows above. Input tokens are all input (cache-miss input + cache read + cache write); total tokens = input + output; cache hit rate = cache read / input × 100%. Statistics accumulate only within the current host process, reset on plugin restart and are not written to disk; cancelled or interrupted requests without usage data are not counted. While the settings page is open it refreshes every 5 seconds; you can also click "Refresh" to read immediately.

## Local operation

The host starts a dedicated proxy child process per account and plan, listening on a random `127.0.0.1` port; every interface is protected by a temporary random key. Control messages go over parent-child IPC. When an account switches or the plugin deactivates, the associated processes are closed and pending requests are cancelled.

Credentials are persisted by the DSH credentials service in the `llm-zcode` domain. The proxy child process only receives the credential snapshot of the account that owns the current request; browser RPC only receives public state. The device identity uses a UUID generated and persisted by the plugin. Proxy logs do not enter DSH sessions.

The original project's automatic plan claiming, MCP gateway, async queue and Responses API are disabled in this integration. Model calls follow the platform's published captcha configuration, where `skip_model_request` decides whether a model request needs verification; when manual verification is required, a verification prompt is returned.

Each DSH model attempt sends one request to the local proxy. The proxy keeps the original project's connection and protocol handling; DSH handles outer transient-error retries. Tool calls and results round-trip in the original DSH session; a stream interruption after content was emitted prompts to continue the current session.

## CLI and headless

The terminal entry uses the same DSH credential store and proxy core:

```bash
dsh plugin --profile web exec dsh-zcode login --platform zai
dsh plugin --profile web exec dsh-zcode status --platform zai --plan start-plan
dsh plugin --profile web exec dsh-zcode quota --platform zai --plan start-plan
dsh plugin --profile web exec dsh-zcode disconnect --platform zai
```

`--home <DSH directory>` selects the DSH data directory. The login command prints the official authorization link; press Ctrl+C to cancel.

The CLI and the web UI follow the locale from `ZCODE_LOCALE` (`zh` / `en` / `ru`), then `LC_ALL` / `LC_MESSAGES` / `LANG`; the browser UI follows the navigator language. Chinese is the default.

The DSH headless profile needs the credentials service and a default model enabled explicitly:

```yaml
- id: credentials
  disabled: false
- id: agent-default-model
  config:
    provider: zcode-zai-start-plan
    model: GLM-5.3
    reasoningEffort: high
```

Save the configuration as `zcode-headless.patch.yml`, complete login, then run:

```bash
dsh headless --patch ./zcode-headless.patch.yml "your task"
```

## Development

```bash
npm ci
npm run typecheck
npm test
npm pack
```

`vendor/zcode-api` keeps the pinned proxy source and licenses, `integration` contains the IPC entry and host compatibility parts, and `scripts/build-proxy.mjs` builds the standalone Node proxy. The build also produces the host ESM, the standalone CLI and the browser factory, and checks package entry points and browser boundaries.

UI strings live in `src/i18n`: `zh.ts` is the source of truth, `en.ts` and `ru.ts` must cover the same keys (enforced by the type system), and `tests/i18n.test.ts` pins the locale detection behavior. Tests that assert Chinese messages set `ZCODE_LOCALE=zh` explicitly.

Tests use synthetic credentials and responses and cover account switching, process isolation, tool round-trips, stream cancellation, quotas and RPC. UI interactions and real plan calls are verified manually by the user.

The DSH adapter source is [MIT](../LICENSE); the bundled zcode-api core and its derivatives are CC-BY-NC-SA-4.0, which includes non-commercial and share-alike terms. Sources, changes and dependency licenses are listed in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
