# P2 合成 DOCX 独立渲染证据

本目录只含合成样本。输入 DOCX 位于 `/tmp/ir-p2-exports`，不加入公开仓库；[合成保存任务快照](synthetic-saved-task.json) 留存用于重复生成。这里的 PDF 是验收中间产物，不是产品新增的 PDF 功能。

## 实际执行

2026-10-26 执行以下命令，退出码 `0`：

```sh
python scripts/render-docx-evidence.py \
  /tmp/ir-p2-exports/chinese.docx \
  /tmp/ir-p2-exports/bilingual.docx \
  --task-json /tmp/ir-p2-exports/task.json \
  --output docs/evidence/p2-render
```

脚本为两个文件分别创建 `/tmp` 下的隔离 LibreOffice 用户配置，实际转换为 PDF，再用 Poppler 输出每页 PNG。全部子命令、参数、耗时和退出码见 [render-report.json](render-report.json)。

需要重复生成时，可以使用留存的合成保存任务运行当前导出实现，再执行上述渲染命令。生成步骤不调用翻译服务：

```sh
node --import tsx --input-type=module - <<'JS'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { exportDocx } from './server/docx/export.ts';
const task = JSON.parse(readFileSync('docs/evidence/p2-render/synthetic-saved-task.json', 'utf8'));
mkdirSync('/tmp/ir-p2-exports', { recursive: true });
writeFileSync('/tmp/ir-p2-exports/task.json', JSON.stringify(task, null, 2));
for (const mode of ['chinese', 'bilingual']) {
  writeFileSync(`/tmp/ir-p2-exports/${mode}.docx`, await exportDocx(task, mode));
}
JS
```

- LibreOffice：`LibreOfficeDev 26.8.0.0.alpha0 2c87e51eeaa2b413ff4ae097b2705eea1995d8e5`。
- Poppler `pdftoppm`：`26.05.0`。
- 独立 DOCX 读取：`python-docx 1.2.0`；PDF 文字读取：`PyMuPDF 1.26.6`。
- 输出字体包含 `NotoSansCJKsc-Regular` 与 `LiberationSans`。中文字体实际可用；Arial 在此环境由 Liberation Sans 回退。

## 核验结果

| 项目                                             | 中文导出                                        | 双语导出 |
| ------------------------------------------------ | ----------------------------------------------- | -------- |
| 实际 PDF 页数                                    | 1                                               | 1        |
| 源结构                                           | 11 个段落节点，其中 1 个空段落、10 个可翻译段落 | 同左     |
| 不计首段模式说明的导出段落数                     | 11                                              | 21       |
| 独立重新读取后与保存任务的段落文字及顺序精确比较 | 通过                                            | 通过     |
| PDF 中非空段落文字覆盖（忽略排版空白）           | 无缺失                                          | 无缺失   |
| 模拟标记实际可见                                 | 通过                                            | 通过     |

已分别查看 [中文第 1 页](chinese-1.png) 与 [双语第 1 页](bilingual-1.png)，覆盖本次样本的全部页面：

- 中文字形、标题、段内换行及制表符形成的间隔可见，没有发现方框字或明显裁切。
- 人工保存的第三版「人工审校：合成机器人平台。」出现在正确的项目符号段落。
- 固定项目符号与编号可读。列表在此版本以固定标签导出，修改后不会自动续编号。
- 表格为两行两列；第一行左格的「指标／季度」及第二行右格的金额／预测多段顺序保留。
- `1,200 万美元（USD 12 million）`、`2026` 与对应英文原文在双语文件的同一单元格内可见。
- 双语每个非空来源节点按原文、保存译文排列；空段落仍作为结构保留。

[中文 PDF](chinese.pdf)、[双语 PDF](bilingual.pdf)、[中文提取文字](chinese.txt) 与 [双语提取文字](bilingual.txt) 保留作支持证据。

## 尚未验收

Microsoft Word 实际人工打开、编辑和兼容性检查 **未运行**。LibreOffice 渲染成功不等同 Word 验收，不证明原页级版式保真，也不代表真实 API、实际翻译准确性或专业 IR 材料质量通过。
