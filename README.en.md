# DSH ZCode

**[简体中文](README.md) | English | [Русский](README.ru.md)**

Connects ZCode subscriptions to DeepSeek Harness through a reverse proxy, with support for BigModel and Z.AI Coding Plan and Start Plan models.

The plugin provides a connection and usage UI:

- In "Plugins → ZCode" choose a platform and plan, sign in via the web page (Coding Plan also accepts a manual plan key), and view plan usage.
- After signing in, pick the matching plan's model in the DSH model picker.
- Plugin settings let you adjust the default platform, plan, concurrency, output limit, request timeout and reasoning effort.
- "Token statistics" shows accumulated input, output, cache-read tokens and cache hit rate for each model under each plan.

Install from [npm](https://www.npmjs.com/package/dsh-zcode) or [GitHub Releases](https://github.com/Fanch-hui/dsh-zcode/releases); installation, CLI, headless and development notes are in [docs/usage.en.md](https://github.com/Fanch-hui/dsh-zcode/blob/main/docs/usage.en.md).

The DSH adapter source is [MIT](./LICENSE). The plugin bundles the proxy core of [TriDefender/zcode-api](https://github.com/TriDefender/zcode-api) pinned at `4.8.8.android`; the core and its derivatives are licensed CC-BY-NC-SA-4.0, which includes non-commercial and share-alike terms — see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
