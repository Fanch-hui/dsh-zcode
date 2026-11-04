# Third-party sources and notices

DSH ZCode is licensed under Apache-2.0. Its source is an independently written DSH adapter based on the following public contracts.

## ZCode

- Repository: https://github.com/zai-org/ZCode
- Reference commit: `a9fe401eede6e6e5e01be9048679c206fe6f02d9` (v3.17.2)
- License: Apache-2.0; upstream copyright and notices remain with their authors.
- Protocol references: CLI OAuth initialization/polling, personal Coding Plan key metadata, Project Access Tokens, Z.AI business login, quota response fields, official gateway routing, model option maps, and `config/provider/zcode-builtin.json` revision 43.
- Sources: `apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts`, `docs/model-provider-project-access-token.md`, `apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts`, and the provider catalog.

The plugin implements these public request and response contracts in its own modules. It uses the public request-security edition, whose implementation is a transport pass-through.

## DeepSeek Harness

- Repository: https://github.com/deepseek-ai/deepseek-harness
- Reference release: `dsh-v0.2.2-rc.1` (`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`)
- Compatibility baseline: `dsh-v0.2.2-alpha.3` (`05b1cae8db6e674c5685101494d4eec24652424a`)
- License: MIT. Host and browser DSH/Cordis packages are peer dependencies supplied by the host. The standalone CLI bundles its required service runtime; bundled package licenses accompany the CLI artifact.
- Contract references: `LlmAdapter`, `StreamChunk`, replay envelopes, credentials, volatile Config, Typert RPC, and browser lazy-CJS plugin factories.
- The browser build follows DSH's documented factory format and links the host's React, Zod and UI primitives.

## zcode-api

- Repository: https://github.com/TriDefender/zcode-api
- Reference commit: `158e7653b738cbed0996243eeabd26f816638e81` (4.8.8.android)
- License: CC BY-NC-SA 4.0.
- Used as a behavioral reference for Coding Plan routing and Anthropic compatibility. The distributed plugin contains independently written code and uses its own DSH adapter and UI.

## Runtime dependencies

- Undici: MIT, https://github.com/nodejs/undici
- Zod: MIT, https://github.com/colinhacks/zod

Their packages carry their respective license files. Development tools retain their upstream licenses.
