# PR3 凭据头编码返工

日期：2026-10-29。基线 `010d4bdd9c9150764bd15c3859582bd9ab73f197`；独立验收已通过此前停止、未知状态和 DNS 返工，但额外复现了不可编码凭据被当作网络故障的问题。本轮只修复该确定性门控，不改 UI、预算策略、依赖或模型协议。

## 原因与修复

原正则检查能拒绝换行、空白和控制字符，却允许 CJK、emoji、组合字符或孤立代理项。Node 构造 Authorization 时会因超出可编码范围抛出 `ERR_INVALID_CHAR`；原传输将其包装为可重试网络故障，导致三次尝试与三笔未知预算预留。

新增服务端共用 `isValidBearerCredential`，保留原来的非空、1024 长度、无空白/控制字符策略，同时调用 Node 本身的 `validateHeaderValue('Authorization', 'Bearer …')`。布尔校验捕获异常，不返回 Node 原始异常或凭据。它验证的是头值能否编码，不是认证成功或猜测某种供应商密钥前缀；Node 允许的非空白 Latin-1 值仍可进入后续正常认证流程。[Node 官方接口](https://nodejs.org/download/release/v24.19.0/docs/api/http.html#httpvalidateheadervaluename-value)

控制器在 arm 前检查；OpenAI adapter 在 ready/预留前检查；直连 transport 在 DNS/HTTP 前检查；旧兼容适配器也复用同一规则，避免另一条 Bearer 头路径产生不一致。新代理支线随后同样复用，当前不混入 PR3。

## 实际验证

新增 `server/credential-encoding.test.ts` 32 项：核心跨服务故障、Unicode/C0/DEL、代理项、组合/预组字符、长度、非字符串以及 Node 合法编码对照。红测核心 2 项均失败，实际复现 reserve/lookup/request 各 3、unknownAttempts=3；修复后无启动、无预留、无 DNS/HTTP、无重试、无错误回显。对有效编码则使用本地合成完整响应验证原路径仍可用。

| 检查                   | 退出码 | 结果                                                           |
| ---------------------- | ------ | -------------------------------------------------------------- |
| `npm test`             | 0      | 19 文件 930/930，28.90 秒；公开脚本 10/10                      |
| `npm run lint`         | 0      | 全项目通过                                                     |
| `npm run typecheck`    | 0      | 全项目通过                                                     |
| `npm run format:check` | 0      | 全项目通过                                                     |
| `npm run build`        | 0      | 45 模块 / 3 个客户端文件                                       |
| 完整 Chromium          | 0      | 61/61，201.701460 秒，0 unexpected/flaky/跳过，无重试          |
| 公开内容扫描           | 0      | 全部当前文件、完整 index、历史快照与非空客户端构建，计数见日志 |
| `git diff --check`     | 0      | 无空白错误                                                     |

完整命令与红/绿输出见 [checks-openai-credential.txt](evidence/checks-openai-credential.txt)。单元重 ZIP 继续串行，结束后才启动浏览器；没有放宽断言、重试或期限。依赖/锁文件和 UI 未变，本返工未重复 npm ci/审计。

真实凭据、真实模型调用、部署或合并均为 0；不做真实 API 认证探测。原停止失败关闭与累计预算规则保持。

## 代理支线保存

代理工作仍在 `/workspace/ir-translation-workbench` 的 `feat/cloud-proxy-transport`，此修复在独立 PR3 worktree 中完成。所有代理文件、候选依赖与本地测试结果已保存，另备份为 `/tmp/ir-cloud-proxy-wip-010d-tracked.patch` 和 `/tmp/ir-cloud-proxy-wip-010d-untracked.tar.gz`，不进入本提交。代理支线将通过明确保存 WIP、快进到新修复基线并恢复 WIP 的方式纳入修复，必要时保留双方改动解决冲突。

后续真实 Cloud 占位符替换、平台上游解析约束、真实模型/费用/质量与 Word 人工验证仍未通过；本修复不替代这些门禁。
