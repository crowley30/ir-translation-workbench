import { useEffect, useRef, useState } from 'react';
import type { DocxDocument, DocxImport as ImportResult, DocxParagraph } from '../shared/docx';
import { DOCX_LIMITS } from '../shared/docx';
import type { MockScenario, Style, Task } from '../shared/types';

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
interface Props {
  style: Style;
  scenario: MockScenario;
  mode: 'mock' | 'real' | null;
  ready: boolean;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onCreated: (task: Task, mode: 'mock' | 'real', scenario: MockScenario) => void;
  project?: string;
  context?: string;
}
async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || '文档请求未成功，请重试。');
  if (!data) throw new Error('文档服务响应格式错误，请重试。');
  return data as T;
}
function PreviewParagraph({ paragraph }: { paragraph: DocxParagraph }) {
  return (
    <div
      className={`docx-preview-paragraph ${paragraph.headingLevel ? 'is-heading' : ''}`}
      data-block-id={paragraph.id}
    >
      <small>
        {paragraph.location}
        {paragraph.headingLevel ? ` · 标题 ${paragraph.headingLevel}` : ''}
      </small>
      <p>
        {paragraph.list?.label ? `${paragraph.list.label} ` : ''}
        {paragraph.source || '（空段落，保留结构）'}
      </p>
    </div>
  );
}
export function DocumentPreview({ document }: { document: DocxDocument }) {
  return (
    <details className="docx-preview">
      <summary>查看原文结构</summary>
      <div>
        {document.blocks.map((block) =>
          block.kind === 'paragraph' ? (
            <PreviewParagraph key={block.id} paragraph={block} />
          ) : (
            <div className="docx-preview-table" key={block.id}>
              <table aria-label="原文简单表格">
                <tbody>
                  {block.rows.map((row) => (
                    <tr key={row.id}>
                      {row.cells.map((cell) => (
                        <td key={cell.id} data-cell-id={cell.id}>
                          {cell.paragraphs.map((paragraph) => (
                            <PreviewParagraph key={paragraph.id} paragraph={paragraph} />
                          ))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ),
        )}
      </div>
    </details>
  );
}
export default function DocxImport({
  style,
  scenario,
  mode,
  ready,
  busy,
  onBusyChange,
  onCreated,
  project = '',
  context = '',
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [working, setWorking] = useState<'upload' | 'create' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latestMode = useRef(mode);
  latestMode.current = mode;
  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
      clearTimeout(deadline.current);
      onBusyChange(false);
    },
    [onBusyChange],
  );

  function stop() {
    generation.current++;
    controller.current?.abort();
    clearTimeout(deadline.current);
    lock.current = false;
    setWorking(null);
    onBusyChange(false);
    setNotice('已取消导入，未开始翻译。');
    setError('');
  }
  async function inspect() {
    if (!file || lock.current || busy) return;
    if (!/\.docx$/i.test(file.name)) {
      setError('请选择 .docx 文件。文件扩展名之外，服务端还会验证实际包结构。');
      return;
    }
    if (file.size > DOCX_LIMITS.uploadBytes || !file.size) {
      setError('DOCX 必须非空且不超过 5 MiB。');
      return;
    }
    const version = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    lock.current = true;
    setWorking('upload');
    onBusyChange(true);
    setError('');
    setNotice('');
    setResult(null);
    setAcknowledged(false);
    let timedOut = false;
    deadline.current = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, 15000);
    try {
      const response = await fetch('/api/docx/preflight', {
        method: 'POST',
        headers: { 'Content-Type': DOCX_TYPE, 'X-Filename': encodeURIComponent(file.name) },
        body: file,
        signal: abort.signal,
      });
      const data = await responseJson<ImportResult>(response);
      if (version === generation.current) setResult(data);
    } catch (cause) {
      if (version === generation.current)
        setError(
          timedOut
            ? '预检查超时，已停止等待，请重试或缩小文档。'
            : cause instanceof Error
              ? cause.message
              : '无法预检查文档，请重试。',
        );
    } finally {
      if (version === generation.current) {
        clearTimeout(deadline.current);
        lock.current = false;
        setWorking(null);
        onBusyChange(false);
      }
    }
  }
  async function create() {
    if (
      !result ||
      lock.current ||
      busy ||
      !ready ||
      !mode ||
      result.report.status === 'blocked' ||
      (result.report.status === 'warning' && !acknowledged)
    )
      return;
    const version = ++generation.current,
      submittedMode = mode,
      submittedScenario = scenario;
    const abort = new AbortController();
    controller.current = abort;
    lock.current = true;
    setWorking('create');
    onBusyChange(true);
    setError('');
    setNotice('');
    deadline.current = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await fetch('/api/tasks/docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          importId: result.id,
          style,
          acknowledgeWarnings: acknowledged,
          ...(project ? { project } : {}),
          ...(context ? { context } : {}),
        }),
        signal: abort.signal,
      });
      const created = await responseJson<Task>(response);
      if (version !== generation.current) return;
      if (created.mode !== submittedMode || latestMode.current !== submittedMode) {
        setNotice('服务模式已变化，文档任务已保存；请从任务列表打开，确认模式后再继续。');
        return;
      }
      onCreated(created, submittedMode, submittedScenario);
    } catch (cause) {
      if (version === generation.current)
        setError(
          abort.signal.aborted
            ? '创建结果尚未确认，请检查任务列表或重试。同一次预检查只会创建一个任务。'
            : cause instanceof Error
              ? cause.message
              : '创建文档任务失败，请重试。',
        );
    } finally {
      if (version === generation.current) {
        clearTimeout(deadline.current);
        lock.current = false;
        setWorking(null);
        onBusyChange(false);
      }
    }
  }
  return (
    <section className="docx-card" aria-label="DOCX 导入">
      <div className="card-heading">
        <div>
          <h2>导入 Word 文档</h2>
          <p>
            正文、标题、常见列表和简单表格。先预检查，再逐段审阅。最多 100
            个段落（含空段和表格段）、20,000 字符。
          </p>
        </div>
        <span className="file-tag">DOCX</span>
      </div>
      <div className="docx-upload">
        <label htmlFor="docx-file">选择 .docx 文件（最多 5 MiB）</label>
        <input
          id="docx-file"
          type="file"
          accept=".docx"
          aria-label="上传 DOCX"
          disabled={!!working || busy}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setResult(null);
            setAcknowledged(false);
            setError('');
            setNotice('');
          }}
        />
        <div className="docx-upload-actions">
          <button disabled={!file || !!working || busy} onClick={() => void inspect()}>
            {working === 'upload' ? '正在预检查…' : '上传并预检查'}
          </button>
          {working === 'upload' && (
            <button className="danger" onClick={stop}>
              取消预检查
            </button>
          )}
          {result && (
            <button
              disabled={working === 'create'}
              onClick={() => {
                stop();
                setResult(null);
                setAcknowledged(false);
              }}
            >
              取消导入
            </button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {result && (
        <div className="docx-report">
          <div className="docx-report-heading">
            <h3>DOCX 预检查</h3>
            <span className={`status-badge ${result.report.status === 'blocked' ? 'failed' : ''}`}>
              {result.report.status === 'blocked'
                ? '阻止导入'
                : result.report.status === 'warning'
                  ? '需要知情确认'
                  : '结构检查通过'}
            </span>
          </div>
          <p className="docx-filename">{result.document.filename}</p>
          <div className="docx-stats">
            <span>{result.report.stats.translatableParagraphs} 段文字</span>
            <span>{result.report.stats.emptyParagraphs} 个空段落</span>
            <span>{result.report.stats.tables} 个表格</span>
            <span>{result.report.stats.cells} 个单元格</span>
            <span>{result.report.stats.characters} 字符</span>
          </div>
          {result.report.issues.length > 0 && (
            <ul className="docx-issues">
              {result.report.issues.map((issue, index) => (
                <li className={issue.severity} key={`${issue.code}-${index}`}>
                  <strong>
                    {issue.severity === 'blocking' ? '阻止' : '提示'} · {issue.message}
                  </strong>
                  <small>
                    {issue.count} 处
                    {issue.locations.length
                      ? ` · ${issue.count > issue.locations.length ? '部分位置：' : ''}${issue.locations.join('；')}`
                      : ''}
                  </small>
                </li>
              ))}
            </ul>
          )}
          {result.report.status === 'blocked' && (
            <p role="alert" className="field-error">
              包含可能遗漏文字或含义的结构，不能创建完整文档翻译。请先在原文中处理后重新上传。
            </p>
          )}
          <DocumentPreview document={result.document} />
          <p className="footnote">
            保留可编辑的基础结构，不承诺逐页原样。图片、批注、修订、脚注、合并单元格等未支持内容会明确列出；不执行宏或访问文档外链。
          </p>
          {result.report.status === 'warning' && (
            <label className="docx-ack">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={!!working}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              我已了解基础排版会变化，继续使用可编辑文档
            </label>
          )}
          <button
            className="primary"
            disabled={
              !!working ||
              busy ||
              !ready ||
              result.report.status === 'blocked' ||
              (result.report.status === 'warning' && !acknowledged)
            }
            onClick={() => void create()}
          >
            {working === 'create' ? '正在创建文档任务…' : '创建文档任务并翻译'}
          </button>
        </div>
      )}
    </section>
  );
}
