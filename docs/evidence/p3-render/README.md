# P3 合成导出与替代渲染

本目录全部是合成材料。中文与双语 DOCX 来自最终完整50项浏览器运行的实际下载，不是原始上传包；输入只在 `/tmp/ir-p3-exports`。保存任务快照提供稳定映射、最新人工译文（第3版）、快照和确认失效的复现依据，不含真实用户材料或凭据。

实际执行并退出0：

```sh
python scripts/render-docx-evidence.py /tmp/ir-p3-exports/chinese.docx /tmp/ir-p3-exports/bilingual.docx --task-json /tmp/ir-p3-exports/task.json --output /tmp/ir-p3-render
```

LibreOfficeDev26.8.0.0.alpha0、Poppler26.05.0；中文和双语各1页，全部页面已查看。中文、`& <核对>`、单元格内容均可读，无明显裁切或缺字。python-docx独立比较保存内容与顺序：中文1个、双语2个单元格段落精确匹配；PDF可见文字缺失0。全局“模拟文档·非实际翻译”说明保留。

- [中文页面](chinese-1.png) · [中文PDF](chinese.pdf)
- [双语页面](bilingual-1.png) · [双语PDF](bilingual.pdf)
- [命令、版本和完整比较报告](render-report.json)
- [合成任务快照](synthetic-saved-task.json)

可从快照重新生成两份基本结构 DOCX（不调用翻译或解释服务）：

```sh
node --import tsx --input-type=module <<'JS'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { exportDocx } from './server/docx/export.ts';
const task = JSON.parse(readFileSync('docs/evidence/p3-render/synthetic-saved-task.json', 'utf8'));
mkdirSync('/tmp/ir-p3-exports', { recursive: true });
writeFileSync('/tmp/ir-p3-exports/task.json', JSON.stringify(task, null, 2));
for (const mode of ['chinese', 'bilingual']) {
  writeFileSync('/tmp/ir-p3-exports/' + mode + '.docx', await exportDocx(task, mode));
}
JS
```

浏览器独立解压检查还确认：只有最新已保存人工译文，没有旧译文、项目/背景、复核原因或辅助解释。PDF只是验收中间产物，不是产品新增PDF功能。**Microsoft Word人工检查未运行**；替代渲染不证明Word兼容、页级保真或专业翻译质量。
