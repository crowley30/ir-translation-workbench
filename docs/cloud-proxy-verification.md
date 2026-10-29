# Cloud 代理传输执行证据

日期：2026-10-29。独立 `feat/cloud-proxy-transport` 基于 PR #3 的 `6c3db129179604b0469848252db4d8045af5fe44`，后续 Draft PR 依赖 PR #3，不改其 head、main 或 PR #2。两次 PR3 返工期间代理 WIP 均已保存、快进并无冲突恢复。本阶段只做受控代理传输、必要配置/状态和离线验证。

## 实现与信任边界

精确锁定 `undici@8.12.3`（当前 Node24.19.0，包要求 Node>=22.19.0）。每次尝试使用显式 ProxyAgent，不修改全局 dispatcher、不使用环境绕过选择器。CONNECT 用单独有界 Client：16KiB 头部限制、取消/总期限、单连接/不流水线；非幂等 POST、不加重试拦截器。Agent、响应流及握手中的 socket 都有销毁路径。请求体/响应体分别最多256000/250000字节，OpenAI adapter 更早执行64000字节请求限额。

目标恒为 `https://api.openai.com/v1/responses`，保留主机名用于 CONNECT、SNI 和 HTTP Host。禁止重定向、非官方目标、`NO_PROXY` 绕过、失效后直连回退。API 不是代理配置入口；地址/CA 仅来自受控服务端环境，含 URL 用户信息的代理配置拒绝且不反射。

`TRANSLATION_TRANSPORT=direct` 保留原客户端全 DNS 校验和连接固定；`cloud-proxy` 使用已提供的 `HTTPS_PROXY` / `https_proxy`，两者冲突时失败关闭。存在代理项但未明确选模式时保持未配置；无代理项的本机旧配置仍默认 direct。默认 mock、操作员 false/预算0、两项用户确认及 PR3 的停止失败关闭/未知状态/凭据编码规则全部保留；读取、保存及启用都不连接供应商。不可用传输在凭据读取和 arm 前拒绝。

TLS 保持证书链、主机名和 SNI 校验，不能关闭验证。默认信任集合（包括进程启动时的额外 CA）保留；可额外读取受控 `SSL_CERT_FILE` 公共 PEM CA 包，最多1MiB/512张证书，只接受有效 CA 证书和空白，无私钥或尾随任意数据。显式信任集按证书去重合并，不覆盖已有根。文件读取受限且拒绝管道/设备，不在状态或日志返回路径、文件内容、原异常或代理 URL。

代理解析和访问上游，客户端无法声称具有直连式上游 IP pinning；平台允许域、上游解析/受保护地址规则和秘密替换是外部信任边界。固定目的域与严格 TLS 是应用保证，不能把本地一次 DNS 预检查冒充代理实际连接证明。[官方依据与安全入口](cloud-proxy-reference.md) 分开列出已核实事实与未知项。

## 本地实际协议验证

21 项集成测试实际启动127.0.0.1临时 HTTP/HTTPS 代理，生成临时合成 CA/域名证书，在 CONNECT 后执行 TLS 拦截并仅替换合成占位符。代理只在本地生成 surrogate response，不转发外部上游。运行时选择、`NO_PROXY='*'` 不绕过、严格段落 ID、费用对账、停止保留未知费用都经过实际本地 socket 路径。

不受信任 CA、错误域名、错误代理证书、403/407、重定向、超长 CONNECT 头、慢握手/头/正文、超限正文及取消均有回归；坏 Unicode 凭据在0 TCP/CONNECT之前拒绝。私钥仅临时生成和清理，没有提交、日志输出或真实凭据。另有85传输单测、50配置测试、21运行时门禁测试，以及5项只读配置界面测试；此前930单元与61浏览器用例未改断言。

## 当前环境非秘密配置核对

仅检查必需的代理格式与公共 CA：两个 HTTPS 代理项均为 HTTP scheme、根路径、无 query/fragment 和 URL 用户信息；未打印主机、端口值、路径或证书内容。Node默认121根，其中额外CA1张已加载；SSL_CERT_FILE包含154张公共CA，故需要合并且不能误用16张上限。

安装完成后，用只包含传输模式、两个代理项和公共CA路径的 allowlist 环境对象（没有复制全部process.env、没有读取OPENAI_API_KEY）调用配置解析和工厂构造：`mode=cloud-proxy, ready=true, upstreamDns=managed-proxy, factoryCreatedWithoutConnection=true`。这只证明当前非秘密配置可解析；构造没有连接代理或发送认证请求，不能证明真实路由、上游域许可或秘密注入。

## 实际检查

| 命令/检查                 | 退出码 | 实际结果                                                                             |
| ------------------------- | ------ | ------------------------------------------------------------------------------------ |
| `npm ci --ignore-scripts` | 0      | 从锁文件安装338包，10秒；未执行依赖安装脚本                                          |
| `npm test`                | 0      | 23文件1107/1107，27.23秒；公开脚本10/10                                              |
| `npm run lint`            | 0      | 全项目通过                                                                           |
| `npm run typecheck`       | 0      | 全项目通过                                                                           |
| `npm run format:check`    | 0      | 全项目通过                                                                           |
| `npm run build`           | 0      | 45模块、3个客户端文件                                                                |
| `npm audit`               | 0      | 0漏洞                                                                                |
| 新5项 Chromium 定向       | 0      | 5/5，11.521397秒，0失败/flaky/跳过                                                   |
| 完整 Chromium             | 0      | 66/66，238.940889秒，0失败/flaky/跳过                                                |
| 公开内容扫描              | 0      | 提交前 HEAD133/index145/工作145；历史330快照/11提交；客户端3文件。提交后另复扫新提交 |
| `git diff --check`        | 0      | 无空白错误                                                                           |

重ZIP继续单worker、串行、原15秒期限；全部单元完成后才启动浏览器。完整命令、失败和最终输出见 [checks-cloud-proxy.txt](evidence/checks-cloud-proxy.txt)。

## 失败与修正记录

- Undici8已移除`throwOnError`选项，首轮代理17用例中16失败于CONNECT前；按锁定版本接口移除错误参数后继续验证。没有把未建连当成功。
- 实际超限正文需要将Undici相应错误归为安全格式错误，已修正；握手/取消的连接清理有明确回归。TLS拒绝时最初的剩余socket计数源自fixture将底层socket包装为TLSSocket后未更新追踪，不证明产品泄漏；修复fixture追踪并保持零未关闭连接断言，未放宽期限。
- 运行时21项初跑因async helper返回Promise后错误调用`.expect`全部失败，并造成未等待请求在store关闭后返回500；修正测试辅助函数，不删除门禁/无网络断言。最终21项通过。
- 初步配置工厂核对误与npm ci同时启动，模块尚在重装导致导入失败；安装结束后串行重跑成功。显式给.env.example调用Prettier无解析器退出2；最终全项目格式检查另外通过。
- 本地HTTPS代理IP-SNI产生Node `DEP0123`弃用警告，原样记录，未关闭TLS验证或将警告说成验证失败；依赖安装保留现有ESLint弃用提示。原始失败日志保留在/tmp并摘入执行记录。

## 界面与未运行门禁

[代理状态界面](evidence/cloud-proxy-synthetic.png) 来自明确标注“合成”的浏览器路由状态，只证明只读展示与门禁，不是实际Cloud连接成功证据。页面不收代理URL、CA或密钥，显示代理侧DNS与配置未验证边界。默认状态未知同步及紧急停止仍保留。

真实Cloud代理路由、network-secret占位符替换、保存的允许域/上游解析策略、OpenAI认证/模型权限、真实token/账单和翻译质量 **未运行**。Microsoft Word、部署和外部访问 **未运行**；未重复LibreOffice渲染，旧DOCX导出及最新保存内容由全量回归覆盖。首次后续真实试跑累计1美元已确认，但本轮没有安全入口配置、真实密钥读取或模型请求。

用户只能在实现独立验收后，按 [阶段计划](cloud-proxy-plan.md) 的官方HTTP secrets/Personal vault入口提供同名Key、选定环境和允许域；平台实际代理与信任配置由运行环境提供，不要求用户猜填。直接Environment variable同样是官方方案，但原值对任务程序可见，不能静默替换Network secret隔离方式。

本阶段完成只推送独立Draft PR，停待父任务验收；不合并、不部署、不打开真实调用门禁。未发现权限阻塞。
