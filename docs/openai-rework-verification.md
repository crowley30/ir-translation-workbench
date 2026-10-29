# PR3 独立验收返工

日期：2026-10-29。本轮基线 `b969a77ba3d140d8d73f41e6c65ca3b8ac8216f6`，在独立 worktree `/workspace/ir-translation-workbench-pr3-fix` 修改同一 `feat/openai-provider` / Draft PR #3，不改 main 或 PR #2。

## 精确修复

1. **停止持久化失败仍继续发送。** 预算账本在任何读写前先设置进程内撤销标记，停止即清除 active 和其配置版本；持久化失败不会恢复权限。路由无论停止落盘成功与否都会取消所有运行任务，取消先中止全部 transport 再尝试保存状态。一轮累计费用、未知预留均保留。重启如无法落盘 disarm，runtime 保持本地关闭；必须存储恢复、成功写入及用户重新明确启动才能重开，不自动恢复真实调用。
2. **等待 202 时停止入口失效。** 任务取消使用独立锁；全局停止/切 mock 可打断翻译等待、状态读取或启动等待，不随普通 posting 一起禁用。请求代次和 AbortController 阻止迟到响应覆盖已取消状态；中止等待不冒充服务端已回滚，错误后重新读取。
3. **凭据无效却报告 ready。** 对原值检查空白、控制字符和长度，不将末尾换行 trim 成合法值。先构造并检查 candidate.ready，后持久化 arm；有效 ready 同时要求 active.ready。错误只返回固定消息，不回显合成或真实凭据。
4. **刷新误报默认关闭。** 首态为未知，面板关闭也自动读取本地控制状态；真实翻译创建/继续/重译在状态未知或与服务配置不同步时禁用。读取失败保持未知，仍保留紧急停止入口。GET 不请求供应商。
5. 同 tick 取消在排队 DNS 前再次检查，DNS/HTTP 均为 0；原来会多查一次 DNS 的路径已补测。

## 回归与证据

新增 `server/live-provider-rework.test.ts` 13 项、`tests/openai-rework.spec.ts` 6 项，并给 transport 增加 1 项取消测试。没有修改原有 55 项浏览器断言，也没有放宽期限。

红测实际执行：后端精确故障注入只拒绝 disarm 的写入，13 项中 9 失败/4 通过，复现停止返回 503 后第二次发送与任务完成；同 tick DNS 红测 1 失败。修复后 backend/budget/adapter/transport 定向 270/270；新浏览器 6/6，18.380816 秒。原始输出见 [checks-openai-rework.txt](evidence/checks-openai-rework.txt)。

| 命令                   | 退出码 | 结果                                                             |
| ---------------------- | ------ | ---------------------------------------------------------------- |
| `npm test`             | 0      | 18 文件 898/898，30.68 秒；公开脚本 10/10                        |
| `npm run lint`         | 0      | 全仓库通过                                                       |
| `npm run typecheck`    | 0      | 全仓库通过                                                       |
| `npm run format:check` | 0      | 全仓库通过                                                       |
| `npm run build`        | 0      | 45 模块 / 3 个客户端文件                                         |
| 完整 Chromium          | 0      | 61/61，241.162604 秒，0 unexpected/flaky/跳过，无重试            |
| 公开内容扫描           | 0      | 完整 HEAD/index/工作文件/历史快照/客户端构建；实际计数见执行记录 |
| `git diff --check`     | 0      | 无空白错误                                                       |

本修复不改依赖或锁文件，未重复 npm ci/审计；沿用第一阶段已审计的锁定依赖。单元（重 ZIP 继续串行、15 秒原期限）结束后才启动完整浏览器，未并行争用。所有 provider 都是注入合成服务，真实模型请求、真实凭据配置/读取/传输仍为 0。读取本地状态不等于读取密钥值；浏览器只获取存在性与非敏感配置。

## 代理支线保存与后续基线

`feat/cloud-proxy-transport` 保留在原 `/workspace/ir-translation-workbench`，代理工作未混进本修复：仅精确安装 `undici@8.12.3` 的 package/lock 改动、`server/cloud-proxy.integration.test.ts` 和两份 `docs/cloud-proxy-*.md` 草稿。在本修复提交的检查点，代理实现/配置文件尚未创建，集成用例尚未运行；未生成任何合成私钥或连接代理。

另有 `/tmp/ir-cloud-proxy-wip-tracked.patch` 和 `/tmp/ir-cloud-proxy-wip-untracked.tar.gz` 备份。本修复 push 后代理分支将快进纳入新的 PR3 修复提交，再继续独立支线；不通过改动 PR3 head 来开发代理。当前 Cloud 真实密钥代理、实际供应商/计费、专业质量与 Word 仍未验收，无合并/部署或真实调用。
