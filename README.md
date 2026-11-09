# DSH ZCode

将 ZCode 订阅通过反向代理接入 DeepSeek Harness，支持 BigModel、Z.AI 的 Coding Plan 与 Start Plan 模型。

本插件提供连接与使用界面：

- 在「插件 → ZCode」选择平台与套餐，完成网页登录（Coding Plan 也支持手工套餐 Key），并查看套餐用量。
- 登录后，在 DSH 模型选择器中选择对应套餐的模型即可使用。
- 插件设置可调整默认平台、套餐、并发数、输出上限、请求超时和思考强度。
- 「Token 统计」按每个套餐下的每个模型分别显示累计的输入、输出、缓存读取 token 与缓存命中率。

安装包见 [GitHub Releases](https://github.com/Fanch-hui/dsh-zcode/releases)，安装、CLI、headless 与开发说明见仓库 [docs/usage.md](https://github.com/Fanch-hui/dsh-zcode/blob/main/docs/usage.md)。

DSH 适配源码采用 [MIT](./LICENSE)。插件随包携带 [TriDefender/zcode-api](https://github.com/TriDefender/zcode-api) 固定版本 `4.8.8.android` 的代理核心；该核心与其派生部分使用 CC-BY-NC-SA-4.0，包含非商业与相同许可要求，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
