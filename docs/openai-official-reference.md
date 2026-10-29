# OpenAI 接入：官方核对依据

核对日期：2026-10-29。只读取公开官方文档与现有仓库，未查询真实 `/models`、配置密钥、执行连接测试或生成付费响应。本文记录协议及价格依据，不证明当前账户模型权限、余额、赠送额度适用范围、截止时刻或专业翻译质量。

## 本期协议与模型

官方推荐新项目使用 Responses；Chat Completions 仍受支持。本期 OpenAI 适配器应使用固定官方 HTTPS Responses 端点，另保留其它 provider 的独立扩展点，不将两种响应结构混为一个协议。[Responses 迁移指南](https://developers.openai.com/api/docs/guides/migrate-to-responses)

本期静态目录仅列出以下两个已核对的模型 ID。官方页面只列出这些规范 ID，未提供可据此采用的日期快照 ID；它们不是应用保证永久不变的固定模型版本。Luna 默认仅是成本选择，尚无实际翻译质量比较。

| ID              | 标准输入 USD / 百万 token | 30 分钟缓存写入 | 12 小时缓存写入 | 标准输出 | 应用输入预留费率 |
| --------------- | ------------------------- | --------------- | --------------- | -------- | ---------------- |
| `gpt-6-luna`    | 0.10                      | 0.125           | 0.25            | 0.50     | 0.25             |
| `gpt-6.1-terra` | 1.00                      | 1.25            | 2.50            | 5.00     | 2.50             |

两者支持 Responses、Structured Outputs 和 `reasoning.effort: "none"`。应用选择 `none` 避免依赖默认 reasoning 配置；如日后增加其它模型，应逐一验证参数兼容性。官方模型页的上下文和输出容量远高于本应用限额，不能据此扩大本期文档输入承诺。[Luna 模型页](https://developers.openai.com/api/docs/models/gpt-6-luna)、[Terra 模型页](https://developers.openai.com/api/docs/models/gpt-6.1-terra)

价格取 Standard、全球、短上下文文本费率，输入预留采用较高的 12 小时缓存写入价，不把缓存命中或折扣当保证。Fast、区域处理、长上下文及其它计费功能会改变价格，本期不得静默启用。静态表不会联网更新，放行真实使用前须复核费率与实际账户能力。[官方价格表](https://developers.openai.com/api/docs/pricing)、[缓存计价说明](https://developers.openai.com/api/docs/guides/prompt-caching)

`shared/openai-models.ts` 只导出公开目录和费率。输出默认 4,096 token、应用硬上限 8,192 token；输入请求的序列化内容（原文、指导、上下文及术语）最多 64,000 UTF-8 字节。服务端仍须独立执行限额，不能只依赖下拉选项。`max_output_tokens` 包含可见输出和 reasoning，不是“保证得到多少译文”；触顶后可能没有完整译文而仍有费用。[Responses 请求参数](https://developers.openai.com/api/reference/resources/responses/methods/create)、[reasoning 成本说明](https://developers.openai.com/api/docs/guides/reasoning)

## 完整响应与错误处理

Responses 的 JSON Schema 位于 `text.format`，使用 `type: "json_schema"`、命名 schema 和 `strict: true`；每层对象都应拒绝额外属性。结构化输出不能替代应用的段落 ID、数量、译文非空、完成状态和来源绑定检查。拒绝、截断、过滤或其它非完整状态不可因 JSON 可解析而记为成功。[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

本期可使用同步、非流式请求，设置 `store: false`、`background: false`，不传工具或历史会话 ID。同步取消通过中止连接实现；官方 cancel 接口只支持 background 响应。中止等待不证明远端未执行或不会计费，重试前必须继续计入应用费用预留。[Background 与取消限制](https://developers.openai.com/api/docs/guides/background)、[取消接口](https://developers.openai.com/api/reference/resources/responses/methods/cancel/)

429 需区分速率限制和计费限制。余额、项目/组织费用或组织用量耗尽不会被重试修复；检查 `error.code`，也兼顾 `insufficient_quota` 类型。真正限流、`slow_down` 和 503 可按有限次数退避，并尊重有效 `Retry-After`；若服务器要求等待超出应用本轮等待上限，应结束并提示稍后重试，不能抢先重发。不要叠加 SDK 的隐式重试与应用重试。[错误码](https://developers.openai.com/api/docs/guides/error-codes)、[限流处理](https://developers.openai.com/api/docs/guides/rate-limits)

## Cloud 密钥入口与运行兼容性

当前 Cloud 的环境配置提供 Environment variables 与 HTTP secrets（Network secret）。后者按 Key、Value、Allowed domains 配置，向程序交付 placeholder，由 HTTPS 代理在允许的 443 端口目的域请求中替换真实值，适用于 setup 和 task 阶段。个人值入口为 Settings → Codex Cloud → Personal vault → Add → Network secret；环境必须请求同名 key，且 applies-to 范围匹配。不要把 raw key 写进仓库、数据库、前端、日志或 setup 生成文件。[当前环境变量与网络密钥文档](https://developers.openai.com/codex/environments/cloud-environments)

网络密钥替换要求使用环境配置的 HTTPS 代理。自行直连、DNS pinning 或普通 TCP CONNECT 隧道不能被假设具备相同替换能力。当前实现只有服务端直接环境变量传输，尚未实现 Cloud 网络密钥代理路径，实际兼容性也未联调；这是后续 Cloud 真实试跑的独立工程门禁，不能宣称 placeholder 已可真实认证。本文未读取或修改此环境的秘密值或管理配置。[代理与网络密钥限制](https://developers.openai.com/codex/environments/cloud-environments#connect-to-tcp-services)

旧版 Cloud 文档中的秘密仅 setup 可用、agent 阶段移除规则属于 Legacy 产品，不能当作当前 HTTP secrets 的规则；也不能把普通环境变量称为同等的代理保护机制。[Legacy 环境说明](https://developers.openai.com/codex/environments/cloud-environment)

## 真实试跑仍需单独放行

服务端凭据引用、模型选择和应用预算设置不是连接授权。首次真实测试累计 1 美元现已获确认，覆盖全部请求和重试；本期仍只用合成材料与注入假服务，不能因预算确认或赠送额度邮件而放行真实调用。正式运行前还需用户安全配置凭据、确认模型权限/价格/预算、验收网络路径与 DNS/TLS/重定向策略，再由明确用户动作启动。

OpenAI 提供组织/项目 hard spend limit，但执行存在传播延迟，记录费用可能略超；普通 spend alert 也不等于限额。应用预留应覆盖每次尝试，费用表仅是所列条件下的保守规划快照，不是供应商绝对账单保证，不代表真实调用已获放行。[官方费用限额](https://developers.openai.com/api/docs/guides/spend-limits)
