# DSH ZCode

在 DeepSeek Harness 中使用 BigModel、Z.AI 的 Coding Plan 与 Start Plan 模型。

本插件提供连接与使用界面：

- 在「插件 → ZCode」选择平台与套餐，完成网页登录（Coding Plan 也支持手工套餐 Key），并查看套餐用量。
- 登录后，在 DSH 模型选择器中选择对应套餐的模型即可使用。
- 插件设置可调整默认平台、套餐、并发数、输出上限、请求超时和思考强度。

安装、CLI、headless 与开发说明见仓库 `docs/usage.md`，不随插件包分发。

插件随包携带 [TriDefender/zcode-api](https://github.com/TriDefender/zcode-api) 固定版本 `4.8.8.android` 的代理核心。DSH 适配源码采用 Apache-2.0；随包分发的核心及其派生部分遵循 CC-BY-NC-SA-4.0，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
