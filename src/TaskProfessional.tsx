import { useEffect, useRef, useState } from 'react';
import { professionalApi as api } from './professional-api';
import {
  PROFESSIONAL_LIMITS,
  type TermApplicationPreview,
  type TermRecord,
} from '../shared/professional';
import type { Task } from '../shared/types';

interface Props {
  task: Task;
  disabled: boolean;
  onChanged(task: Task): void;
}
const LAYERS = { project: '项目', fund: '基金', technical: '技术' };
const termLabel = (entry: TermRecord) =>
  `${LAYERS[entry.layer]}${entry.project ? ` / ${entry.project}` : ''}：${entry.source} → ${entry.retainSource ? '保留英文原文' : entry.target}${entry.enabled ? '' : '（停用）'}`;
const termGuidance = (entry: TermRecord) =>
  `优先级 ${entry.priority}；英文匹配${entry.caseSensitive ? '区分大小写' : '忽略大小写'}；适用说明：${entry.note || '无'}；可接受译法：${entry.alternatives.length ? entry.alternatives.join('；') : '无'}`;
const termFullLabel = (entry: TermRecord) => `${termLabel(entry)}；${termGuidance(entry)}`;

export default function TaskProfessional({ task, disabled, onChanged }: Props) {
  const snapshot = task.professional?.snapshot;
  const [project, setProject] = useState(snapshot?.project ?? '');
  const [context, setContext] = useState(snapshot?.context ?? '');
  const [preview, setPreview] = useState<TermApplicationPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<'preview' | 'apply' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const request = useRef<AbortController | null>(null);
  const lock = useRef(false);
  const previousTaskId = useRef(task.id);
  const current = useRef({ id: task.id, revision: task.revision ?? 0 });
  current.current = { id: task.id, revision: task.revision ?? 0 };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    request.current?.abort();
    request.current = null;
    lock.current = false;
    setProject(snapshot?.project ?? '');
    setContext(snapshot?.context ?? '');
    setPreview(null);
    setConfirmed(false);
    setBusy(false);
    setOperation(null);
    setError('');
    if (previousTaskId.current !== task.id) setNotice('');
    previousTaskId.current = task.id;
    return () => {
      request.current?.abort();
    };
  }, [task.id, snapshot?.id, snapshot?.project, snapshot?.context]);

  const blocked = disabled || task.status === 'running';
  const stale = !!preview && preview.taskRevision !== (task.revision ?? 0);
  async function requestPreview() {
    if (blocked || lock.current) return;
    lock.current = true;
    setBusy(true);
    setOperation('preview');
    setError('');
    setNotice('');
    setPreview(null);
    setConfirmed(false);
    const target = { ...current.current };
    const controller = new AbortController();
    request.current = controller;
    try {
      const value = await api<TermApplicationPreview>(
        `/tasks/${encodeURIComponent(target.id)}/terminology-preview`,
        { method: 'POST', signal: controller.signal, body: JSON.stringify({ project, context }) },
      );
      if (!mounted.current || controller.signal.aborted || current.current.id !== target.id) return;
      if (current.current.revision !== target.revision || value.taskRevision !== target.revision) {
        setError('任务内容已更新，请重新预览后再应用术语。');
        return;
      }
      setPreview(value);
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted && current.current.id === target.id)
        setError(reason instanceof Error ? reason.message : '术语预览失败，请重试。');
    } finally {
      if (mounted.current && request.current === controller) {
        request.current = null;
        lock.current = false;
        setBusy(false);
        setOperation(null);
      }
    }
  }
  async function apply() {
    if (blocked || lock.current || !preview || !confirmed || stale) return;
    const target = { ...current.current },
      token = preview.token;
    const controller = new AbortController();
    request.current = controller;
    lock.current = true;
    setBusy(true);
    setOperation('apply');
    setError('');
    setNotice('');
    try {
      const updated = await api<Task>(`/tasks/${encodeURIComponent(target.id)}/terminology-apply`, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ token, confirm: true }),
      });
      if (!mounted.current || controller.signal.aborted || current.current.id !== target.id) return;
      onChanged(updated);
      setPreview(null);
      setConfirmed(false);
      setNotice(
        '任务术语快照已更新；已有译文和人工修改保持原样。需要更新译文时，请明确选择段落重译。',
      );
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted && current.current.id === target.id)
        setError(reason instanceof Error ? reason.message : '应用术语快照失败，请重新预览。');
    } finally {
      if (mounted.current && request.current === controller) {
        request.current = null;
        lock.current = false;
        setBusy(false);
        setOperation(null);
      }
    }
  }
  function cancelPreview() {
    if (operation !== 'preview' || !request.current) return;
    const pending = request.current;
    request.current = null;
    pending.abort();
    lock.current = false;
    setBusy(false);
    setOperation(null);
    setPreview(null);
    setConfirmed(false);
    setError('');
    setNotice('已停止等待术语预览，可以重新预览。任务快照和译文未因此改变。');
  }
  function changeProject(value: string) {
    setProject(value);
    setPreview(null);
    setConfirmed(false);
  }
  function changeContext(value: string) {
    setContext(value);
    setPreview(null);
    setConfirmed(false);
  }
  const previousEntries = snapshot?.entries ?? [];

  return (
    <details className="professional-panel task-professional">
      <summary>
        项目与术语快照{' '}
        <small>
          {snapshot
            ? `库版本 ${snapshot.libraryVersion} · ${snapshot.entries.filter((entry) => entry.enabled).length} 条启用`
            : '尚未建立快照'}
        </small>
      </summary>
      <p className="professional-note">
        任务使用固定术语快照。术语库的新修改不会自动影响此任务；重新应用只更新快照，不替换或重译已有内容。
      </p>
      {snapshot ? (
        <div className="professional-snapshot">
          <p>
            当前快照：<code>{snapshot.id}</code> ·{' '}
            {new Date(snapshot.createdAt).toLocaleString('zh-CN')}
          </p>
          <p>
            项目：{snapshot.project || '未指定'} · 背景：{snapshot.context || '未填写'}
          </p>
          <details>
            <summary>查看当前快照词条（{snapshot.entries.length}）</summary>
            {snapshot.entries.length ? (
              <ul>
                {snapshot.entries.map((entry) => (
                  <li key={entry.id}>
                    {termLabel(entry)}
                    <small>{termGuidance(entry)}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p>此快照没有词条。</p>
            )}
          </details>
        </div>
      ) : (
        <p className="professional-note">
          此任务尚未保存术语快照，可以先预览项目、背景与当前术语库。
        </p>
      )}
      <details className="professional-history">
        <summary>历史快照（{task.professional?.snapshotHistory.length ?? 0}）</summary>
        <p className="professional-note">历史记录只读，不因术语库编辑而改写。</p>
        {task.professional?.snapshotHistory.length ? (
          <ul>
            {task.professional.snapshotHistory.map((item) => (
              <li key={item.id}>
                <code>{item.id}</code>
                <small>
                  库版本 {item.libraryVersion} · 项目 {item.project || '未指定'} ·{' '}
                  {item.entries.length} 条 · {new Date(item.createdAt).toLocaleString('zh-CN')}
                </small>
                <details className="professional-history-content">
                  <summary>查看历史快照内容</summary>
                  <p>项目：{item.project || '未指定'}</p>
                  <p>背景：{item.context || '未填写'}</p>
                  {item.entries.length ? (
                    <ul>
                      {item.entries.map((entry) => (
                        <li key={entry.id}>{termFullLabel(entry)}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>此历史快照没有术语词条。</p>
                  )}
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="professional-note">暂无历史快照。</p>
        )}
      </details>
      {error && (
        <div role="alert" className="professional-error">
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="professional-notice">
          {notice}
        </p>
      )}
      <fieldset className="professional-form" disabled={blocked || busy}>
        <label>
          当前任务项目
          <input
            aria-label="当前任务项目"
            value={project}
            maxLength={PROFESSIONAL_LIMITS.project}
            onChange={(event) => changeProject(event.target.value)}
          />
        </label>
        <label>
          当前任务背景
          <textarea
            aria-label="当前任务背景"
            value={context}
            maxLength={PROFESSIONAL_LIMITS.context}
            onChange={(event) => changeContext(event.target.value)}
            placeholder="仅填写本次翻译所需的项目背景，最多 2,000 字符"
          />
        </label>
        <button type="button" disabled={blocked || busy} onClick={() => void requestPreview()}>
          {busy && !preview ? '生成术语预览中…' : '预览重新应用术语'}
        </button>
      </fieldset>
      {busy && operation === 'preview' && (
        <button type="button" onClick={cancelPreview}>
          取消预览请求
        </button>
      )}
      {preview && (
        <section className="professional-preview" aria-label="术语重新应用预览">
          <h3>确认前查看变化</h3>
          <dl>
            <div>
              <dt>项目</dt>
              <dd>
                {snapshot?.project || '未指定'} → {preview.snapshot.project || '未指定'}
              </dd>
            </div>
            <div>
              <dt>背景</dt>
              <dd>
                {snapshot?.context || '未填写'} → {preview.snapshot.context || '未填写'}
              </dd>
            </div>
            <div>
              <dt>术语库版本</dt>
              <dd>
                {snapshot?.libraryVersion ?? '无'} → {preview.snapshot.libraryVersion}
              </dd>
            </div>
          </dl>
          <p>将保留 {preview.preservedEditedParagraphs} 段人工修改；不会自动重译。</p>
          {preview.changedSources.length ? (
            <ul className="professional-term-changes">
              {preview.changedSources.map((source) => (
                <li key={source}>
                  <strong>{source}</strong>
                  <div>
                    <span>原快照：</span>
                    {previousEntries
                      .filter((entry) => entry.source === source)
                      .map(termFullLabel)
                      .join('；') || '无'}
                  </div>
                  <div>
                    <span>新快照：</span>
                    {preview.snapshot.entries
                      .filter((entry) => entry.source === source)
                      .map(termFullLabel)
                      .join('；') || '无'}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="professional-note">
              没有词条变化；项目或背景仍可能更新，请检查上方前后内容。
            </p>
          )}
          {preview.conflicts.length > 0 && (
            <div className="professional-conflicts">
              <h4>需人工处理的术语冲突（{preview.conflicts.length}）</h4>
              <p>冲突不会自动改写译文，请逐段核实。</p>
              <ul>
                {preview.conflicts.map((item, index) => (
                  <li key={`${item.paragraphId}-${index}`}>
                    <strong>{item.location || item.paragraphId}</strong>：{item.conflict.text} ·
                    原文位置 [{item.conflict.start}, {item.conflict.end})
                    <ul>
                      {item.conflict.entries.map((entry) => (
                        <li key={entry.id}>{termFullLabel(entry)}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {stale && (
            <p role="alert" className="professional-error">
              任务已更新，此预览已失效，请重新预览后确认。
            </p>
          )}
          <label className="professional-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={blocked || busy || stale}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已检查术语变化，确认仅更新任务快照
          </label>
          <button
            type="button"
            className="primary"
            disabled={blocked || busy || stale || !confirmed}
            onClick={() => void apply()}
          >
            {busy ? '应用术语快照中…' : '确认应用术语快照'}
          </button>
        </section>
      )}
      <div className="professional-explanation">
        <h3>辅助解释</h3>
        <p>
          当前没有启用独立的辅助解释服务，此能力尚未实现。这里不会生成或保存专业解释，也不会把解释混入译文。
        </p>
        <button type="button" disabled>
          辅助解释尚未开放
        </button>
      </div>
    </details>
  );
}
