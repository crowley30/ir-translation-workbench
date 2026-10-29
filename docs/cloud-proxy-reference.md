# Cloud 代理与安全配置核对依据

核对日期：2026-10-29。只读取官方公开文档、仓库代码及必要的非敏感配置元数据；未读取真实密钥、未打印代理 URL 或认证值，未创建秘密，也没有向 OpenAI 发认证或模型请求。本文区分官方保证、当前可见证据与应用设计，不把推断写成已验证连通性。

## Cloud 的两种配置方式

当前官方 Cloud 配置同时提供 Environment variables 和 HTTP secrets。前者把值直接交给程序；Network secret 则提供占位符，由代理按允许域替换，适用于 setup 与 task 的 HTTPS 443。两者不应使用同一个 Key，普通变量也不具有原值隔离于任务进程的性质。[官方配置表](https://developers.openai.com/codex/environments/cloud-environments#configure-environment-variables-and-network-secrets)

已核实的个人值入口是 Settings → Codex Cloud → Personal vault → Add，Type 可选 Environment variable 或 Network secret，Key 需匹配环境请求，Applies to 需包含所用环境。环境自有 network secret 会加入目的域许可；个人值和普通变量不会自动开放网络。环境更新需 Republish 并在新任务生效，既有任务保留原状态。[个人值与环境更新](https://developers.openai.com/codex/environments/cloud-environments#supply-personal-values)

官方另列 `proxy:8088` 的 TCP/VPN CONNECT 路径，明确不拦截 TLS 或注入秘密；需要秘密替换的请求须使用配置的 HTTPS 代理。不能将该 TCP 地址当作 HTTP secret 的固定地址，也不能据此断言所有 CONNECT 都不支持替换。[TCP 与 HTTPS 代理的区别](https://developers.openai.com/codex/environments/cloud-environments#connect-to-tcp-services)

## 代理实现依据

本阶段基于 PR #3 冻结基线 `6c3db129179604b0469848252db4d8045af5fe44`，选择 Node 24.19.0 与精确锁定的 `undici@8.12.3`，采用逐请求显式 dispatcher，不修改全局 dispatcher。该版本的 ProxyAgent 支持代理连接、HTTPS CONNECT，以及分别配置请求端和代理端 TLS 的 `requestTls` / `proxyTls`；构造本身不等于发出模型请求。本应用只开放所需 HTTP/HTTPS 代理，不因此开放库支持的其它代理协议或任意目标。[Undici 8.12.3 ProxyAgent](https://github.com/nodejs/undici/blob/v8.12.3/docs/docs/api/ProxyAgent.md)

EnvHttpProxyAgent 会读取代理及 no-proxy 环境规则，并允许目标绕过代理；因此本阶段不依赖它自动选择路径，避免 `NO_PROXY` 将本应进行秘密替换的请求变成直连。[同版本 EnvHttpProxyAgent](https://github.com/nodejs/undici/blob/v8.12.3/docs/docs/api/EnvHttpProxyAgent.md)

Node 24.19.0 本身也提供代理 agent，但 PR #3 的 `agent:false` 不会因为环境中有代理配置就自动改用另一条路径。增加 Cloud 模式必须是局部、可验证的传输选择，不能假定设置全局开关便能解决现有请求行为。[Node 24.19 原生代理支持](https://nodejs.org/download/release/v24.19.0/docs/api/http.html#built-in-proxy-support)

`NODE_EXTRA_CA_CERTS` 在 Node 进程启动时扩展信任根；运行中修改该变量不会重新加载。显式设置 `ca` 会取代默认及额外 CA，故应用如显式加载平台公开证书，必须保持所需默认信任，并始终验证主机名及证书链。不能因系统存在 `SSL_CERT_FILE` 就推断任意 Node 客户端已采用它。[Node CA 配置](https://nodejs.org/download/release/v24.19.0/docs/api/cli.html#node_extra_ca_certsfile)

## 本应用采用的配置契约

服务端显式选择 `TRANSLATION_TRANSPORT=direct` 或 `cloud-proxy`。检测到平台代理配置项却未选择模式时，状态为未配置，不推断直连已获允许；没有代理配置项时才保留默认直连。Cloud 模式只取实际 `HTTPS_PROXY` / `https_proxy`，冲突或缺失即拒绝，不使用 `NO_PROXY` 绕过，也不向其它代理变量或直连回退。这是本应用的限制，不能把一般环境变量约定说成 Cloud 文档已公布了具体代理地址。

CA 通过 `tls.getCACertificates('default')` 读取当前 Node 的实际默认信任集合，而非只取 bundled 根；该集合可包含启动时加载的额外根。应用可将服务端 `SSL_CERT_FILE` 的受限 PEM 证书包追加到集合中，大小最多 1 MiB，只接受证书、拒绝私钥；此显式支持不代表 Node 自动采用该变量。配置值、文件内容和原始读取错误不对外反射。[Node 默认 CA 集合](https://nodejs.org/download/release/v24.19.0/docs/api/tls.html#tlsgetcacertificatestype)

显式 ProxyAgent 的 CONNECT 解析也必须有独立头部大小和等待限额，不能只限制模型响应正文。本轮合成代理测试将给出该实现选择的离线证据；文档所述 API 能力不是实际 Cloud 秘密替换通过的证据。具体的服务端字段与验收目标见 [阶段计划](cloud-proxy-plan.md)。

当前冻结基线的所有凭据头统一通过 Node 标准 `validateHeaderValue` 校验：适配器在费用预留前检查，Cloud 路径在网络 agent 创建前检查。非法值以固定安全原因拒绝，不回显输入或原始异常；这项输入边界不替代 TLS、固定目的地或预算门禁。

## 可见元数据与不可推导结论

本轮主执行者只检查完成任务所需的非秘密元数据，未打印基础设施地址、代理端口、完整 URL、CA 路径或证书正文，也未接触真实 API Key：

| 项目                          | 当前可见结果                                                                              | 不能据此推导                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `HTTPS_PROXY` / `https_proxy` | 两项均存在；URL 为 HTTP 代理、根路径，无 URL 用户信息、query 或 hash                      | 代理已连接、允许域已保存或真实占位符替换有效      |
| Node 默认信任                 | 当前 Node 24.19.0 的 default 集合 121 项，extra 集合 1 项；额外公开 CA 已在进程启动时加载 | 任意代理所用证书均受信任，或 TLS 主机名校验已通过 |
| `SSL_CERT_FILE`               | 指向的公开 CA 包 154 项，其中有不在 Node 默认集合中的证书                                 | Node 已自动采用全部证书，或真实代理链已验证       |

这些结果支持保留默认信任并有界追加公开 CA 包的配置选择；它们不是实际网络或认证测试。之前的存在性检查也发现 HTTP/HTTPS、NO_PROXY 及 CA 配置项，但存在性本身不证明路由已通。

Cloud 的公开说明没有给出当前 HTTPS 代理的固定地址、完整 wire contract 或通用 CA 路径；也没有保证所有直接 HTTPS 都可用。实际代理必须来自平台提供的服务端配置，不能由浏览器、上传文档或猜测地址决定。Codex 自身客户端的 CA 变量约定不能被当成所有 Node 程序的自动行为。[Cloud 连接要求](https://developers.openai.com/codex/environments/cloud-environments#connect-to-tcp-services)、[Codex 变量适用范围](https://developers.openai.com/codex/config-file/environment-variables#authentication-and-network)

## 明确的信任边界

直连路径可继续在客户端校验 DNS 并固定连接 IP。Cloud 代理路径需保留官方 hostname，由受信任平台代理执行上游解析、访问及可能的 TLS 替换；应用验证代理信任及逻辑目标，但不能证明代理最终连接了本地预检查的同一个 IP。固定目标、禁止重定向、无绕过/直连回退和 TLS 验证必须继续保留，不能将一次本地 DNS 检查命名为代理模式的上游 pinning。

本地 TLS 拦截假代理可以验证应用是否遵守上述契约及错误边界，不能证明真实平台的解析/受保护地址策略、真实密钥替换或账户认证。真实策略与首次合成试跑须在独立验收后另行验证；本轮不更改平台策略，不配置真实秘密，不执行收费请求。首次未来试跑累计 1 美元已确认，但预算确认不等于当前真实调用已放行。
