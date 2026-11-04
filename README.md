# DSH ZCode

通过 [TriDefender/zcode-api](https://github.com/TriDefender/zcode-api) 在 DeepSeek Harness 中使用 BigModel、Z.AI 的 Coding Plan 和 ZCode Start Plan。

插件随包携带原项目的代理核心，固定版本为 `4.8.8.android`，提交 `158e7653b738cbed0996243eeabd26f816638e81`。登录、凭据解析、套餐端点、请求签名、系统消息组织和上游转发均复用该核心。DSH 适配层负责模型目录、消息与流的转换；工具执行、审批、会话和子 Agent 由 DSH 负责。

## 安装与使用

开发基线为 DSH **0.2.2-rc.1**，兼容范围 `>=0.2.2-alpha.3 <0.3.0`，Node **24.9.0 及以上**。桌面版使用应用附带的 Node。

```bash
dsh plugin --profile desktop add ./dsh-zcode-0.2.0.tgz
```

npm 安装的 DSH 可将 profile 改为 `web`。桌面版也可通过插件管理添加本地 `.tgz`。

1. 打开「插件 → ZCode」，选择平台及套餐。
2. 点击「登录」，在官方网页完成授权。既有插件登录记录会在首次使用时交由代理核心解析。
3. 在 DSH 模型选择器中选择对应套餐，例如 `ZCode · Z.AI Start Plan`。
4. 在插件设置页查看额度，点击「刷新」获取当前用量。

两个套餐共享同一平台的网页登录。Coding Plan 还接受手工套餐 Key。默认并发为 2，输出上限 32,000 tokens，请求超时 300 秒，思考强度为「高」。

## 模型与套餐

| 模型 | 输入 | 上下文 | 输出能力上限 | 思考档位 |
| --- | --- | --- | --- | --- |
| GLM-5.3 | 文本 | 1,000,000 | 128,000 | low / high / max |
| GLM-5.3-Flash | 文本、图片 | 1,000,000 | 128,000 | low / high / max |

四个 provider 分别为 `zcode-bigmodel`、`zcode-zai`、`zcode-bigmodel-start-plan`、`zcode-zai-start-plan`。套餐和模型选择决定使用的通道，平台返回额度或权限错误时展示相应状态。

额度查询调用代理核心的 `collectQuotaSnapshot`。Start Plan 展示模型余额桶，Coding Plan 展示套餐窗口；查询缓存 60 秒，手动刷新获取最新数据。Token 统计按 DSH 的输入、缓存读取、缓存写入和输出口径转换。

## 本机运行

Host 按账号及套餐启动独立的代理子进程，监听 `127.0.0.1` 的随机端口，每个接口使用临时随机密钥保护。控制消息走父子进程 IPC。账号切换或插件停用时关闭关联进程，取消正在等待的请求。

凭据由 DSH credentials 服务在 `llm-zcode` 域持久化。代理子进程仅接收当前请求所属账号的凭据快照；浏览器 RPC 只接收公开状态。设备身份使用插件持久化生成的 UUID。代理日志不进入 DSH 会话。

原项目的自动领取套餐、MCP 网关、异步队列和 Responses 接口在此集成中关闭。模型调用遵循平台公开的验证码配置，其中 `skip_model_request` 决定模型请求是否需要验证；需要人工验证时返回验证提示。

每个 DSH 模型 attempt 向本机代理发送一次请求。代理保留原项目的连接与协议处理逻辑，DSH 负责外层瞬时错误重试。工具调用与结果在原 DSH 会话中往返，已输出内容的流中断提示继续当前会话。

## CLI 与 headless

终端入口使用相同的 DSH 凭据库和代理核心：

```bash
dsh plugin --profile web exec dsh-zcode login --platform zai
dsh plugin --profile web exec dsh-zcode status --platform zai --plan start-plan
dsh plugin --profile web exec dsh-zcode quota --platform zai --plan start-plan
dsh plugin --profile web exec dsh-zcode disconnect --platform zai
```

`--home <DSH目录>` 指定 DSH 数据目录。登录命令给出官方授权链接，按 Ctrl+C 取消。

DSH headless profile 需要显式启用凭据服务及默认模型：

```yaml
- id: credentials
  disabled: false
- id: agent-default-model
  config:
    provider: zcode-zai-start-plan
    model: GLM-5.3
    reasoningEffort: high
```

将配置保存为 `zcode-headless.patch.yml`，完成登录后执行：

```bash
dsh headless --patch ./zcode-headless.patch.yml "你的任务"
```

## 开发

```bash
npm ci
npm run typecheck
npm test
npm pack
```

`vendor/zcode-api` 保存固定版本的代理源码和许可证，`integration` 为 IPC 入口及宿主兼容部分，`scripts/build-proxy.mjs` 构建独立 Node 代理。构建同时生成 Host ESM、独立 CLI 和浏览器 factory，并检查包入口与浏览器边界。

测试使用合成凭据和响应，覆盖账号切换、进程隔离、工具往返、流取消、额度和 RPC。界面操作及实际套餐调用由用户手动验收。

DSH 适配源码采用 Apache-2.0；随包分发的 zcode-api 核心及其派生部分遵循 CC-BY-NC-SA-4.0。来源、变更和依赖许可证见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
