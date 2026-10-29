import { useCallback, useEffect, useRef, useState } from 'react';
import type { MockScenario, ServiceConfig, Style, Task } from '../shared/types';
import { MAX_CHARACTERS, MAX_PARAGRAPHS } from '../shared/types';
import { api } from './api';
import { startPolling } from './polling';
import DocxImport from './DocxImport';
import TerminologyManager from './TerminologyManager';
import TaskProfessional from './TaskProfessional';
import ParagraphReview from './ParagraphReview';
import ProviderSettings from './ProviderSettings';
import LiveProvider from './LiveProvider';
import { PROFESSIONAL_LIMITS } from '../shared/professional';
import './professional.css';

const STATUS: Record<Task['status'], string> = {
  draft: '待翻译',
  running: '翻译中',
  completed: '已完成',
  partial: '部分完成',
  failed: '翻译失败',
  cancelled: '已取消',
};
const SCENARIOS: [MockScenario, string][] = [
  ['normal', '正常占位'],
  ['slow', '慢速响应'],
  ['timeout', '请求超时'],
  ['rate-limit', '429 限流'],
  ['server-error', '5xx 服务故障'],
  ['partial', '部分段落失败'],
  ['malformed', '响应格式错误'],
];
type Draft = { value: string; revision: number };
const taskFromUrl = () => new URLSearchParams(window.location.search).get('task');
const keyFor = (taskId: string, paragraphId: string) => `${taskId}:${paragraphId}`;

export default function App() {
  const [config, setConfig] = useState<ServiceConfig | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(taskFromUrl);
  const [task, setTask] = useState<Task | null>(null);
  const [input, setInput] = useState('');
  const [style, setStyle] = useState<Style>('business');
  const [project, setProject] = useState('');
  const [context, setContext] = useState('');
  const [scenario, setScenario] = useState<MockScenario>('normal');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState('');
  const [connectionErrors, setConnectionErrors] = useState<{ config?: string; tasks?: string }>({});
  const [taskReadError, setTaskReadError] = useState('');
  const [notice, setNotice] = useState('');
  const [posting, setPosting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [docxBusy, setDocxBusy] = useState(false);
  const [importEpoch, setImportEpoch] = useState(0);
  const latestConfig = useRef<ServiceConfig | null>(null);
  const [loading, setLoading] = useState(!!selectedId);
  const currentId = useRef(selectedId);
  const actionLock = useRef(false);
  currentId.current = selectedId;

  const refreshList = useCallback(async () => {
    setTasks(await api<Task[]>('/tasks'));
  }, []);
  const acceptTask = useCallback((data: Task) => {
    if (currentId.current !== data.id) return;
    setTask((previous) => {
      if (
        previous?.id === data.id &&
        ((previous.revision !== undefined && data.revision !== undefined
          ? previous.revision > data.revision
          : previous.updatedAt > data.updatedAt) ||
          previous.paragraphs.some(
            (p) => p.revision > (data.paragraphs.find((next) => next.id === p.id)?.revision ?? -1),
          ))
      )
        return previous;
      return data;
    });
  }, []);
  const refreshTask = useCallback(
    async (id: string) => {
      const data = await api<Task>(`/tasks/${id}`);
      acceptTask(data);
      if (currentId.current === id) setTaskReadError('');
    },
    [acceptTask],
  );
  useEffect(() => {
    const stopConfig = startPolling({
      request: (signal) => api<ServiceConfig>('/config', { signal }),
      onSuccess: (value) => {
        latestConfig.current = value;
        setConfig(value);
        setConnectionErrors((previous) => ({ ...previous, config: undefined }));
      },
      onError: (error) =>
        setConnectionErrors((previous) => ({ ...previous, config: error.message })),
    });
    const stopTasks = startPolling({
      request: (signal) => api<Task[]>('/tasks', { signal }),
      onSuccess: (value) => {
        setTasks(value);
        setConnectionErrors((previous) => ({ ...previous, tasks: undefined }));
      },
      onError: (error) =>
        setConnectionErrors((previous) => ({ ...previous, tasks: error.message })),
    });
    return () => {
      stopConfig();
      stopTasks();
    };
  }, []);
  useEffect(() => {
    if (!selectedId) {
      setTask(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    return startPolling({
      request: (signal) => api<Task>(`/tasks/${selectedId}`, { signal }),
      onSuccess: (value) => {
        acceptTask(value);
        setTaskReadError('');
        setLoading(false);
      },
      onError: (error) => {
        setTaskReadError(error.message);
        setLoading(false);
      },
      intervalMs: 700,
    });
  }, [selectedId, acceptTask]);
  useEffect(() => {
    const pop = () => {
      setSelectedId(taskFromUrl());
      setTask(null);
      setTaskReadError('');
      setError('');
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (Object.keys(drafts).length) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [drafts]);
  function navigate(id: string | null) {
    setImportEpoch((value) => value + 1);
    window.history.pushState(
      {},
      '',
      id ? `?task=${encodeURIComponent(id)}` : window.location.pathname,
    );
    currentId.current = id;
    setSelectedId(id);
    setTask(null);
    setTaskReadError('');
    setError('');
    setNotice('');
  }
  async function action(work: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setPosting(true);
    setError('');
    setNotice('');
    try {
      await work();
      // A successful mutation stays successful even if its follow-up list refresh fails.
      try {
        await refreshList();
        setConnectionErrors((previous) => ({ ...previous, tasks: undefined }));
      } catch (e) {
        setConnectionErrors((previous) => ({
          ...previous,
          tasks: e instanceof Error ? e.message : '无法读取任务列表，请重试。',
        }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请重试。');
    } finally {
      actionLock.current = false;
      setPosting(false);
    }
  }
  const paragraphCount = input.trim() ? input.trim().split(/\n\s*\n/).length : 0;
  const overLimit =
    input.length > (config?.maxCharacters ?? MAX_CHARACTERS) ||
    paragraphCount > (config?.maxParagraphs ?? MAX_PARAGRAPHS);
  function createTask() {
    if (actionLock.current || docxBusy || !config?.ready || !input.trim() || overLimit) return;
    const submitted = { text: input, style, scenario, mode: config.mode, project, context };
    setCreating(true);
    void action(async () => {
      const created = await api<Task>('/tasks', {
        method: 'POST',
        body: JSON.stringify({
          text: submitted.text,
          style: submitted.style,
          ...(submitted.project ? { project: submitted.project } : {}),
          ...(submitted.context ? { context: submitted.context } : {}),
        }),
      });
      if (created.mode !== submitted.mode || latestConfig.current?.mode !== submitted.mode) {
        setNotice('服务模式已变化，原文草稿已保留；已创建的任务可从列表打开，请确认模式后再继续。');
        return;
      }
      navigate(created.id);
      setTask(created);
      setInput((current) => (current === submitted.text ? '' : current));
      const started = await api<Task>(`/tasks/${created.id}/translate`, {
        method: 'POST',
        body: JSON.stringify({ scenario: submitted.scenario }),
      });
      acceptTask(started);
    }).finally(() => setCreating(false));
  }
  function openImported(
    created: Task,
    submittedMode: 'mock' | 'real',
    submittedScenario: MockScenario,
  ) {
    if (created.mode !== submittedMode || latestConfig.current?.mode !== submittedMode) {
      setError('服务模式已变化，文档任务已保存，请从列表打开后确认。');
      return;
    }
    void action(async () => {
      navigate(created.id);
      setTask(created);
      const started = await api<Task>(`/tasks/${created.id}/translate`, {
        method: 'POST',
        body: JSON.stringify({ scenario: submittedScenario }),
      });
      acceptTask(started);
    });
  }
  function downloadDocx(mode: 'chinese' | 'bilingual') {
    if (!task?.document) return;
    const id = task.id;
    void action(async () => {
      const response = await fetch(`/api/tasks/${id}/docx?mode=${mode}`);
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || 'DOCX 导出失败，请重试。');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = `ir-${id}-${mode}.docx`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice('已导出当前已保存的文档。');
    });
  }
  function translate(paragraphId?: string) {
    if (!task) return;
    const selected = paragraphId ? task.paragraphs.find((p) => p.id === paragraphId) : undefined;
    if (selected && drafts[keyFor(task.id, selected.id)]) {
      setError('请先保存本段修改，再选择重译。');
      return;
    }
    if (
      selected?.edited &&
      !window.confirm('本段包含人工修改。确定用新的翻译结果替换本段吗？其他段落不会改变。')
    )
      return;
    const id = task.id;
    void action(async () => {
      const updated = await api<Task>(`/tasks/${id}/translate`, {
        method: 'POST',
        body: JSON.stringify({ scenario, ...(paragraphId ? { paragraphIds: [paragraphId] } : {}) }),
      });
      acceptTask(updated);
    });
  }
  function cancel() {
    if (!task) return;
    const id = task.id;
    void action(async () => {
      const updated = await api<Task>(`/tasks/${id}/cancel`, { method: 'POST', body: '{}' });
      acceptTask(updated);
    });
  }
  function save(paragraphId: string) {
    if (!task) return;
    const id = task.id,
      key = keyFor(id, paragraphId),
      draft = drafts[key];
    if (!draft) return;
    const current = task.paragraphs.find((p) => p.id === paragraphId)!;
    const conflict = draft.revision !== current.revision;
    if (conflict && !window.confirm('服务已有更新的结果。确定用当前人工草稿覆盖最新内容吗？'))
      return;
    const expectedRevision = conflict ? current.revision : draft.revision;
    void action(async () => {
      const updated = await api<Task>(`/tasks/${id}/paragraphs/${paragraphId}`, {
        method: 'PATCH',
        body: JSON.stringify({ translation: draft.value, expectedRevision }),
      });
      acceptTask(updated);
      setDrafts((prev) => {
        const next = { ...prev };
        if (next[key]?.value === draft.value) delete next[key];
        else if (next[key])
          next[key] = {
            ...next[key],
            revision: updated.paragraphs.find((p) => p.id === paragraphId)!.revision,
          };
        return next;
      });
      setNotice('人工修改已保存。');
    });
  }
  const currentDirty = task?.paragraphs.some((p) => drafts[keyFor(task.id, p.id)]);
  const exportText = () =>
    task
      ? `${task.title}\n${task.mode === 'mock' ? '【模拟模式：以下包含占位内容，不是实际翻译】' : '【机器翻译草稿：请人工审校】'}\n文体：${task.style === 'faithful' ? '忠实合同' : '商务文体'}\n\n${task.paragraphs.map((p, i) => `[${i + 1}] ${p.status === 'done' ? '' : `【${p.status === 'failed' ? '翻译失败' : '尚未完成'}】\n`}${p.translation || '【无译文】'}`).join('\n\n')}`
      : '';
  function exportFile() {
    if (!task) return;
    const blob = new Blob([exportText()], { type: 'text/plain;charset=utf-8' }),
      url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ir-${task.id}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice('已导出已保存的文本。');
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(exportText());
      setNotice('已复制已保存的译文。');
    } catch {
      setError('浏览器未授予剪贴板权限，请使用文本导出。');
    }
  }
  return (
    <div className="shell">
      <aside className="sidebar">
        <a
          href="/"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            navigate(null);
          }}
        >
          <span className="brand-mark" aria-hidden="true">
            IR
          </span>
          <span>
            IR 翻译工作台<small>IR Translation Workbench</small>
          </span>
        </a>
        <button className="new-task" onClick={() => navigate(null)}>
          <span aria-hidden="true">＋ </span>新建任务
        </button>
        <div className="sidebar-heading">
          翻译任务 <span>{tasks.length}</span>
        </div>
        <nav aria-label="任务列表" className="task-list">
          {tasks.length === 0 && (
            <p className="empty-list">
              第一份翻译，从这里开始。
              <br />
              保存后可以随时回来。
            </p>
          )}
          {tasks.map((item) => (
            <a
              key={item.id}
              href={`?task=${item.id}`}
              aria-current={selectedId === item.id ? 'page' : undefined}
              className={`task-link ${selectedId === item.id ? 'selected' : ''}`}
              onClick={(e) => {
                e.preventDefault();
                navigate(item.id);
              }}
            >
              <span className="task-title">{item.title}</span>
              <span className="task-meta">
                <span className={`status-dot ${item.status}`} />
                {STATUS[item.status]}
                <span className="task-date">
                  {new Date(item.updatedAt).toLocaleDateString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                  })}
                </span>
              </span>
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="avatar" aria-hidden="true">
            IR
          </span>
          <div>
            本地工作区<small>单人 · 本地持久化</small>
          </div>
          <span className="online-dot" />
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span>
            工作空间 <span className="slash">/</span>{' '}
            <strong>{selectedId ? '段落审校' : '文本翻译'}</strong>
          </span>
          <span className={`mode-pill ${config?.mode === 'real' ? 'real' : ''}`}>
            <span />
            {config ? (config.mode === 'mock' ? '模拟模式' : '真实服务') : '检查服务状态中'}
          </span>
        </header>
        <main>
          <div className={`service-banner ${config?.mode === 'real' ? 'real-banner' : ''}`}>
            <span className="banner-icon">{config?.mode === 'real' ? '↗' : 'i'}</span>
            <div>
              <strong>
                {config?.mode === 'mock'
                  ? '当前为模拟模式，不会产生实际翻译'
                  : config?.mode === 'real'
                    ? '真实服务模式 · 机器翻译需要人工审校'
                    : '正在读取服务配置'}
              </strong>
              <p>
                {config?.mode === 'mock'
                  ? '用于验证流程，输出均为明确标注的占位内容；不调用收费 API。'
                  : (config?.label ?? '请确认服务端正在运行。')}
              </p>
            </div>
          </div>
          {Object.entries(connectionErrors).map(
            ([source, message]) =>
              message && (
                <div role="alert" className="alert" key={source}>
                  {message}
                  <button
                    aria-label={source === 'config' ? '关闭配置错误提示' : '关闭任务列表错误提示'}
                    onClick={() =>
                      setConnectionErrors((previous) => ({ ...previous, [source]: undefined }))
                    }
                  >
                    ×
                  </button>
                </div>
              ),
          )}
          {taskReadError && (
            <div role="alert" className="alert">
              {taskReadError}
            </div>
          )}
          {error && (
            <div role="alert" className="alert">
              {error}
              <button aria-label="关闭错误提示" onClick={() => setError('')}>
                ×
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="notice">
              {notice}
            </div>
          )}
          {loading && !task ? (
            <div className="loading">正在打开任务…</div>
          ) : selectedId && !task ? (
            <div className="loading">
              任务暂时无法打开。
              <button
                onClick={() => {
                  void refreshTask(selectedId).catch((e) => {
                    if (currentId.current === selectedId) setTaskReadError(e.message);
                  });
                }}
              >
                重新加载
              </button>
            </div>
          ) : task ? (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">TRANSLATION REVIEW</p>
                  <h1>{task.title}</h1>
                  <p className="description">
                    {task.style === 'faithful' ? '忠实合同' : '商务文体'} <span>·</span>{' '}
                    {task.paragraphs.length} 个段落 <span>·</span>{' '}
                    {task.mode === 'mock' ? '模拟任务' : '真实翻译任务'}
                  </p>
                </div>
                <span className={`status-badge ${task.status}`}>{STATUS[task.status]}</span>
              </div>
              <div className="review-toolbar">
                <div className="save-state">
                  {currentDirty ? (
                    <>
                      <span className="unsaved-dot" />
                      有未保存的修改
                    </>
                  ) : (
                    <>✓ 已保存至本机服务</>
                  )}
                  <small>
                    {task.paragraphs.filter((p) => p.status === 'done').length}/
                    {task.paragraphs.length} 段已完成
                  </small>
                </div>
                <div className="toolbar-actions">
                  <button disabled={!!currentDirty} onClick={() => void copy()}>
                    复制译文
                  </button>
                  <button disabled={!!currentDirty} onClick={exportFile}>
                    导出文本
                  </button>
                  {task.status === 'running' ? (
                    <button className="danger" disabled={posting} onClick={cancel}>
                      取消翻译
                    </button>
                  ) : (
                    <button
                      className="primary"
                      disabled={
                        posting ||
                        !config?.ready ||
                        !task.paragraphs.some((p) => p.status !== 'done' && !p.edited)
                      }
                      onClick={() => translate()}
                    >
                      继续翻译
                    </button>
                  )}
                </div>
              </div>
              {task.status === 'running' && (
                <div className="run-info" role="status">
                  正在逐段处理，您可以编辑并保存译文。人工保存会受到保护，取消后可继续未完成的段落。
                </div>
              )}
              <TaskProfessional
                key={task.id}
                task={task}
                disabled={posting || !!currentDirty}
                onChanged={acceptTask}
              />
              <div className="review-columns">
                <span>
                  英文原文 <small>SOURCE</small>
                </span>
                <span>
                  中文译文 <small>TRANSLATION · 可编辑</small>
                </span>
              </div>
              <div className="paragraph-list">
                {task.paragraphs.map((p, index) => {
                  const key = keyFor(task.id, p.id),
                    draft = drafts[key];
                  return (
                    <section className="paragraph" key={p.id} aria-label={`段落 ${index + 1}`}>
                      <div className="source-panel">
                        <div className="paragraph-header">
                          <span className="paragraph-number">
                            {String(index + 1).padStart(2, '0')}
                          </span>
                          <span>{p.location || '原文'}</span>
                        </div>
                        <p>{p.source}</p>
                      </div>
                      <div className="translation-panel">
                        <div className="paragraph-header">
                          <span>
                            {p.status === 'running'
                              ? '处理中…'
                              : p.status === 'failed'
                                ? '处理失败'
                                : p.status === 'done'
                                  ? '已完成'
                                  : p.status === 'cancelled'
                                    ? '已取消'
                                    : '待处理'}
                          </span>
                          {p.edited && <span className="edited-tag">人工修改</span>}
                          {task.mode === 'mock' && <span className="mock-tag">模拟内容</span>}
                        </div>
                        <textarea
                          aria-label={`译文 ${index + 1}`}
                          value={draft?.value ?? p.translation}
                          placeholder="译文将在这里显示，也可以手动编辑"
                          onChange={(e) => {
                            const value = e.target.value;
                            setDrafts((prev) => ({
                              ...prev,
                              [key]: { value, revision: prev[key]?.revision ?? p.revision },
                            }));
                          }}
                        />
                        {p.error && <p className="paragraph-error">{p.error}</p>}
                        <div className="paragraph-actions">
                          <span>
                            {draft
                              ? draft.revision !== p.revision
                                ? '已有新结果，保存时需确认'
                                : '修改尚未保存'
                              : p.edited
                                ? '已保护人工修改'
                                : '自动结果待审校'}
                          </span>
                          <button disabled={!draft || posting} onClick={() => save(p.id)}>
                            保存修改
                          </button>
                          <button
                            disabled={posting || task.status === 'running' || !config?.ready}
                            onClick={() => translate(p.id)}
                          >
                            重译本段
                          </button>
                        </div>
                        <ParagraphReview
                          task={task}
                          paragraphId={p.id}
                          dirty={!!draft}
                          disabled={posting}
                          onChanged={acceptTask}
                        />
                      </div>
                    </section>
                  );
                })}
              </div>
              {task.document && (
                <div className="docx-export">
                  <div>
                    <strong>{task.document.filename}</strong>
                    <p>全部文字段落完成并保存后，可导出可编辑的基础结构；不承诺逐页原样。</p>
                  </div>
                  <div className="toolbar-actions">
                    <button
                      disabled={
                        !!currentDirty ||
                        posting ||
                        task.status === 'running' ||
                        task.paragraphs.some((p) => p.status !== 'done' || !p.translation.trim())
                      }
                      onClick={() => downloadDocx('chinese')}
                    >
                      导出中文 DOCX
                    </button>
                    <button
                      disabled={
                        !!currentDirty ||
                        posting ||
                        task.status === 'running' ||
                        task.paragraphs.some((p) => p.status !== 'done' || !p.translation.trim())
                      }
                      onClick={() => downloadDocx('bilingual')}
                    >
                      导出双语 DOCX
                    </button>
                  </div>
                </div>
              )}
              <p className="footnote">
                复制和导出包含已保存的内容。重译仅作用于选定段落；人工修改过的段落需要确认后才会替换。
              </p>
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">ENGLISH → CHINESE</p>
                  <h1>把英文，译成清晰的中文。</h1>
                  <p className="description">为科技基金 IR 的每一次沟通，多留一份从容。</p>
                </div>
                <span className="workspace-label">
                  文本工作台 <span>01</span>
                </span>
              </div>
              <div className="compose-card">
                <div className="card-heading">
                  <div>
                    <h2>粘贴英文内容</h2>
                    <p>支持邮件、商务沟通与合同文本。空行分隔的内容会逐段对照。</p>
                  </div>
                  <span className="file-tag">TEXT</span>
                </div>
                <label className="sr-only" htmlFor="source-input">
                  输入英文
                </label>
                <textarea
                  id="source-input"
                  className="source-input"
                  value={input}
                  disabled={creating || docxBusy}
                  onChange={(e) => {
                    if (!creating && !docxBusy) setInput(e.target.value);
                  }}
                  placeholder={
                    'Dear team,\n\nPaste your English text here…\n\n在这里粘贴英文，开始逐段翻译与审校。'
                  }
                />
                <div className={`input-meta ${overLimit ? 'invalid' : ''}`}>
                  <span>
                    {paragraphCount} 个段落 · 最多 {config?.maxParagraphs ?? MAX_PARAGRAPHS} 段
                  </span>
                  <span>
                    {input.length.toLocaleString()} /{' '}
                    {(config?.maxCharacters ?? MAX_CHARACTERS).toLocaleString()} 字符
                  </span>
                </div>
                {creating && (
                  <p className="field-help" role="status">
                    正在创建任务，原文和选项暂时锁定；创建失败会保留原文。
                  </p>
                )}
                <div className="professional-compose-fields">
                  <label htmlFor="project-name">项目名称（可选）</label>
                  <input
                    id="project-name"
                    aria-label="项目名称"
                    value={project}
                    maxLength={PROFESSIONAL_LIMITS.project}
                    disabled={creating || docxBusy}
                    onChange={(event) => setProject(event.target.value)}
                    placeholder="匹配该项目的术语，不会自动改写历史任务"
                  />
                  <label htmlFor="translation-context">翻译背景（可选）</label>
                  <textarea
                    id="translation-context"
                    aria-label="翻译背景"
                    value={context}
                    maxLength={PROFESSIONAL_LIMITS.context}
                    disabled={creating || docxBusy}
                    onChange={(event) => setContext(event.target.value)}
                    placeholder="收件人、材料用途、技术或基金语境；作为资料传给服务"
                  />
                  <p className="field-help">
                    文本与 DOCX
                    共用此项目和背景，创建时保存术语快照。全局库的后续修改不会改变历史任务。
                  </p>
                </div>
                {overLimit && (
                  <p role="alert" className="field-error">
                    内容超出上限，请缩短文本后再试。
                  </p>
                )}
                <div className="compose-footer">
                  <div className="style-control">
                    <label htmlFor="style">翻译文体</label>
                    <select
                      id="style"
                      aria-label="文体"
                      value={style}
                      disabled={creating || docxBusy}
                      onChange={(e) => {
                        if (!creating && !docxBusy) setStyle(e.target.value as Style);
                      }}
                    >
                      <option value="business">商务文体</option>
                      <option value="faithful">忠实合同</option>
                    </select>
                  </div>
                  <button
                    className="primary create"
                    disabled={!input.trim() || overLimit || posting || docxBusy || !config?.ready}
                    onClick={createTask}
                  >
                    {creating ? '正在创建…' : '创建并翻译'} <span aria-hidden="true">↗</span>
                  </button>
                </div>
              </div>
              <DocxImport
                key={importEpoch}
                style={style}
                project={project}
                context={context}
                scenario={scenario}
                mode={config?.mode ?? null}
                ready={!!config?.ready}
                busy={posting || creating}
                onBusyChange={setDocxBusy}
                onCreated={openImported}
              />
              <div className="style-notes">
                <div>
                  <span className="note-symbol">Aa</span>
                  <div>
                    <h3>忠实合同</h3>
                    <p>保持原文结构与措辞，优先忠实表达义务、限定和条件。</p>
                  </div>
                </div>
                <div>
                  <span className="note-symbol">✉</span>
                  <div>
                    <h3>商务文体</h3>
                    <p>适合邮件与投资人沟通，表达自然、简洁，保留信息完整性。</p>
                  </div>
                </div>
              </div>
              <div className="next-note">
                <span>专业审校</span> 术语与规则提示辅助核对，不能替代人工判断或专业翻译质量评估。
              </div>
            </>
          )}
          <TerminologyManager disabled={posting || creating || docxBusy} />
          <ProviderSettings disabled={posting || creating || docxBusy} />
          <LiveProvider disabled={posting || creating || docxBusy} />
          {config?.mode === 'mock' && (
            <details className="dev-panel">
              <summary>模拟测试设置</summary>
              <label htmlFor="scenario">模拟场景</label>
              <select
                id="scenario"
                aria-label="模拟场景"
                value={scenario}
                disabled={creating || docxBusy}
                onChange={(e) => {
                  if (!creating && !docxBusy) setScenario(e.target.value as MockScenario);
                }}
              >
                {SCENARIOS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <p>
                仅用于合成样本的流程验收。设置作用于下一次翻译请求；超时、限流与服务故障均会有限重试。
              </p>
            </details>
          )}
        </main>
        <footer className="main-footer">
          <span>IR 翻译工作台 · 为清晰沟通而做</span>
          <span>AI 和具身智能 · IR</span>
        </footer>
      </div>
    </div>
  );
}
