# DSH ZCode

在 DeepSeek Harness 中使用 BigModel 或 Z.AI 登录下的个人 Coding Plan 与 ZCode Start Plan。插件提供原生 LLM Adapter，文本、思考、图片、工具调用和 token 用量直接进入 DSH；文件操作、终端、审批、会话恢复和子 Agent 由 DSH 执行。

## 安装与使用

开发与验证基线：DSH **0.2.2-rc.1**，同时支持 **0.2.2-alpha.3**，Node **24.9.0 及以上**。桌面版使用应用附带的 Node 运行时。运行兼容范围为 `>=0.2.2-alpha.3 <0.3.0`，开发依赖固定至已验证版本。

```bash
dsh plugin --profile web add ./dsh-zcode-0.1.4.tgz
```

此命令适用于 npm 安装的 DSH。桌面版通过应用的插件管理添加本地 `.tgz`，或使用桌面版自带的 `dsh plugin --profile desktop add ./dsh-zcode-0.1.4.tgz`。

1. 在 DSH 的「插件 → ZCode」选择智谱 BigModel 或 Z.AI，并选择 Coding Plan 或 Start Plan。
2. 点击「登录」，打开授权链接，在官方页面完成授权。Coding Plan 首次调用会查找或创建平台的专用凭据元数据，用于签发短期 PAT；Start Plan 使用同一网页登录返回的 ZCode JWT。
3. 在 DSH 统一模型选择器中选择对应平台及套餐下的模型。例如 Z.AI 的 Start Plan 选择 `ZCode · Z.AI Start Plan`。两个套餐共享同一品牌的网页登录。
4. 额度显示在插件设置页；「刷新」读取平台当前的额度与重置时间。

Coding Plan 的高级入口接受用户主动提供的套餐 Key，保存后立即生效。高级参数在插件配置行中保存，默认并发 2、输出上限 32,000 tokens、超时 300 秒、思考强度「高」。

## 模型与用量

| 模型 | 输入 | 上下文 | 输出能力上限 | 思考档位 |
| --- | --- | --- | --- | --- |
| GLM-5.3 | 文本 | 1,000,000 | 128,000 | low / high / max |
| GLM-5.3-Flash | 文本、图片 | 1,000,000 | 128,000 | low / high / max |

目录采用 ZCode 官方 revision 43 的固定能力规则，随插件版本更新。刷新会重新通知 DSH 模型选择器，账户权限和可用额度由平台返回。

Token 统计采用 DSH 口径：未缓存输入、缓存读取、缓存写入分别计数；平台缺少字段时保留未知值。套餐的 Token、积分和工具额度分别显示，更新时间一同保留。额度读取合并并发查询并缓存 60 秒，手动刷新请求最新数据。

Start Plan 使用独立的 ZCode JWT 模型接口与余额接口，按套餐和模型分别展示额度及重置时间。团队项目和额外权益由相应平台返回。

## 请求与凭据

OAuth/PAT 请求按官方动态配置选择直连或 Coding Plan 网关，路由快照按账号隔离并缓存 5 分钟；配置刷新失败保留已有快照，首次刷新失败使用平台标准端点。目标限于 ZCode、BigModel 与 Z.AI 的官方 HTTPS origin，网关身份头按受信路由标记发送。手工 Key 请求使用对应平台的 Anthropic Coding Plan 端点。Start Plan 复用网页登录返回的 ZCode JWT，直接使用其专属接口，设备身份由本插件持久化生成。每次模型流只执行一个 HTTP attempt；安装 DSH 的 `dsh-llm-retry` 时，统一执行最多一次瞬时故障重试。已开始输出的流中断会保留会话中的内容，并提示继续。

同一账号的模型请求按会话公平排队。HTTP 429 按平台业务码区分临时限流、服务繁忙、额度与套餐权限，并显示平台码；只有临时故障进入 DSH 重试，额度与权限问题直接提示对应处理。临时限流的冷却作用于该账号的新请求。队列、凭据等待和网络读取接受取消；断开账号或禁用插件时中止关联工作。切换凭据后，旧回合继续绑定旧账号并停止，下一回合使用新凭据。

Start Plan 与 Coding Plan 使用独立 provider ID；套餐错误直接展示，不自动切换计费通道。Start Plan 的业务错误也会在 HTTP 200 JSON 或 SSE 中解析，额度拒绝保留下一次重新提交能力；平台安全验证和请求规则拒绝显示对应业务码。

凭据存入 DSH credentials 服务的 `llm-zcode` 域，手工 Key 使用独立记录。短期 PAT 与 Z.AI 业务票据仅保存在 Host 内存。RPC 状态、模型目录和会话回放保存公开元数据。DSH 默认本地凭据后端为用户目录中的文件，POSIX 权限为 0600，Windows 访问权限随用户目录 ACL。

授权链接由用户打开；CLI 和远程 Web 可在用户自己的浏览器中完成同一授权。

## CLI 与 headless

安装后，插件自带的终端入口复用同一 DSH 凭据库：

```bash
dsh plugin --profile web exec dsh-zcode login --platform bigmodel
dsh plugin --profile web exec dsh-zcode status --platform bigmodel
dsh plugin --profile web exec dsh-zcode quota --platform bigmodel
dsh plugin --profile web exec dsh-zcode disconnect --platform bigmodel
```

Z.AI 使用 `--platform zai`，Start Plan 的状态或额度查询增加 `--plan start-plan`。登录命令打印官方授权地址，按 Ctrl+C 取消；`--home <DSH目录>` 可指定 DSH 数据目录。命令输出公开状态，凭据由官方 credentials-local 服务保存。具备 DSH authorization 服务的客户端也可通过标准授权流登录。

DSH 默认 headless profile 关闭凭据服务。使用该 profile 时先安装插件：

```bash
dsh plugin --profile headless add ./dsh-zcode-0.1.4.tgz
```

创建 `zcode-headless.patch.yml` 显式启用凭据服务：

```yaml
- id: credentials
  disabled: false
- id: agent-default-model
  config:
    provider: zcode-bigmodel
    model: GLM-5.3
    reasoningEffort: high
```

完成上述 CLI 登录后，启动任务时加载此配置：

```bash
dsh headless --patch ./zcode-headless.patch.yml "你的任务"
```

Z.AI Coding Plan 的 provider 为 `zcode-zai`，Start Plan 为 `zcode-zai-start-plan`；BigModel Start Plan 为 `zcode-bigmodel-start-plan`。Flash 使用 `GLM-5.3-Flash`。

## 开发与验证

```bash
npm ci
npm run typecheck
npm test
npm pack
```

`npm pack` 构建 Host ESM、独立 CLI 与浏览器 lazy-CJS factory，并检查包入口、共享 RPC 描述和客户端边界。Host 和浏览器共享模块由 DSH 提供；独立 CLI 随包携带所需的 DSH 凭据服务运行时。

自动化测试使用人工构造的上游响应，覆盖 OAuth/PAT、账号隔离、流式协议、工具往返、额度、并发、取消和 RPC；构建与包入口在 macOS arm64、Node 24.14.0 验证。真实套餐调用、两平台计费扣减、Windows 安装和界面操作由实际环境验收。

当前 [BigModel 接入规则](https://docs.bigmodel.cn/cn/coding-plan/tool/others)及 [Z.AI 接入规则](https://docs.z.ai/devpack/tool/others)将套餐使用范围限定为官方列出的工具；DSH 接入资格需要平台确认。实际部署需完成该确认及账号联调，平台返回权限拒绝时插件展示对应状态。

源码采用 Apache-2.0，协议依据和依赖许可见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
