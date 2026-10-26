# 中性产品名修正与验收

日期：2026-10-26。基线为远端 `main` 的合并提交 `704dd6c7720004da722b1021a9ead542dec2451d`，经 `git fetch origin` 确认后新建 `fix/neutral-product-name`。本轮只修改品牌与必要的合成证据，不改数据结构、翻译行为或 API 调用限制。

## 改名覆盖

产品中文名统一为 **IR 翻译工作台**，英文名为 **IR Translation Workbench**。网页标题、侧栏标志和名称、工作区称呼、页脚、服务启动提示、README、V1 使用情境和项目术语合成测试（项目名使用 Demo Project）均已调整。图标使用 IR，侧栏使用“本地工作区”。为容纳完整名称只调整品牌区域字号、字距与图标收缩行为。仓库 slug 保持不变。

当前全部受控文本逐份扫描；12 张受控 PNG 全部目视审查，4 份 PDF 的可见文本和元数据逐份提取检查。未发现其余可识别个人姓名样本。含旧品牌的四张完整页面截图来自本轮通过的同名浏览器用例，替换关系如下：

| 当前证据                       | 本轮截图来源                                                              |
| ------------------------------ | ------------------------------------------------------------------------- |
| `evidence/desktop-compose.png` | workbench：temporary config read failure 恢复后的 `synthetic-compose.png` |
| `evidence/desktop-review.png`  | workbench：save/reopen and text export 的 `synthetic-workbench.png`       |
| `evidence/create-pending.png`  | workbench：delayed create 的 `synthetic-create-pending.png`               |
| `evidence/p2-review.png`       | docx：supported DOCX 的 `synthetic-docx-review.png`                       |

这四张图是本轮重生成的当前品牌证据；既有 P0/P2 命令和运行结果记录保留，不将新图说成原始运行时的截图。其余八张局部界面/导出页面图片及四份 PDF 不含旧品牌，未作无关重绘。PDF 仅是原有合成导出验收证据，Microsoft Word 人工验证、真实 API 与专业翻译质量仍未验收。

## 执行检查

检查结果及完整命令输出见 [checks-neutral-name.txt](evidence/checks-neutral-name.txt)。本轮沿用锁定依赖，未改依赖或锁文件。

| 检查                                            | 退出码 | 结果                                                                     |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| `npm test`                                      | 0      | 13 文件 597/597 Vitest；公开脚本 9/9                                     |
| `npm run lint`                                  | 0      | 全项目通过                                                               |
| `npm run typecheck`                             | 0      | 全项目通过                                                               |
| `npm run format:check`                          | 0      | 全项目通过                                                               |
| `npm run build`                                 | 0      | 43 模块、3 个客户端文件                                                  |
| `npm run test:e2e -- --reporter=list,json,html` | 0      | Chromium 50/50，182.344669 秒，0 失败、flaky 或跳过；无重试              |
| 当前受控文本与 PDF 文案检查                     | 0      | 旧品牌/个人称呼匹配 0；4 份 PDF 各 1 页，元数据同样检查                  |
| PNG 目视检查                                    | 完成   | 全部 12 张；4 张重新生成，8 张无需改动                                   |
| 公开内容检查与 `git diff --check`               | 0      | 完整 HEAD、index、工作文件、历史快照与客户端构建检查；扫描计数见执行记录 |

浏览器报告保留在 `/tmp/ir-neutral-browser-report/index.html`，JSON 为 `/tmp/ir-neutral-browser.json`。最终仅调整合成测试的项目标签后重新运行全部单元/集成与格式、lint、类型检查；浏览器所验产品代码未再修改。

浏览器断言检查精确网页标题、中文品牌、完整英文名、IR 标志和中性工作区称呼；既有文本、DOCX、术语、复核、离线配置流程全部回归。截图只含合成材料。未进行真实 API 连接、配置真实凭据或部署。

## 历史保留范围

基线共有八个可达提交，其中七个旧提交仍保留既有称呼：从 `6ef1e6a` 开始，至合并提交 `704dd6c`（初始 `a44ecb2` 无旧称）。涉及五个历史文本路径：README、V1 计划、index.html、App、术语测试；以及上述四个历史截图路径。桌面输入/审阅图各见于七个旧提交快照，创建等待图六个，P2 审阅图四个。已合并 PR #1 的当前标题及说明未见旧称，但其代码差异仍展示原有称呼，未作修改；更早的说明编辑历史或讨论未另行穷举。

本轮未重写或删除历史，也不 force push。当前版本清理不等于历史清理；是否另行处理历史由父任务向用户说明。本轮新 PR 仅描述中性改名，不写私人对话或用户姓名，保持 Draft 待父任务验收。
