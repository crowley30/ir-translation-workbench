import { useEffect, useRef, useState, type FormEvent } from 'react';
import { professionalApi as api } from './professional-api';
import {
  PROFESSIONAL_LIMITS,
  type TermInput,
  type TermLayer,
  type TermLibrary,
  type TermRecord,
} from '../shared/professional';

const LAYERS: Record<TermLayer, string> = { project: '项目', fund: '基金', technical: '技术' };
const blankTerm = (): TermInput => ({
  layer: 'technical',
  project: '',
  source: '',
  target: '',
  retainSource: false,
  note: '',
  priority: 50,
  enabled: true,
  caseSensitive: false,
  alternatives: [],
});
const message = (error: unknown) =>
  error instanceof Error ? error.message : '术语操作失败，请重试。';

export default function TerminologyManager({ disabled = false }: { disabled?: boolean }) {
  const [library, setLibrary] = useState<TermLibrary | null>(null);
  const [editing, setEditing] = useState<TermRecord | null>(null);
  const [form, setForm] = useState<TermInput>(blankTerm);
  const [alternatives, setAlternatives] = useState('');
  const [reading, setReading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const request = useRef<AbortController | null>(null);
  const lock = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    request.current = controller;
    api<TermLibrary>('/terminology', { signal: controller.signal })
      .then((value) => {
        if (mounted.current && !controller.signal.aborted) {
          setLibrary(value);
          setReadError('');
        }
      })
      .catch((reason) => {
        if (mounted.current && !controller.signal.aborted) setReadError(message(reason));
      })
      .finally(() => {
        if (mounted.current && request.current === controller) {
          request.current = null;
          setReading(false);
        }
      });
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);

  async function reload() {
    if (lock.current || disabled || reading) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setReading(true);
    try {
      const value = await api<TermLibrary>('/terminology', { signal: controller.signal });
      if (mounted.current && !controller.signal.aborted) {
        setLibrary(value);
        setReadError('');
      }
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) setReadError(message(reason));
    } finally {
      if (mounted.current && request.current === controller) {
        request.current = null;
        setReading(false);
      }
    }
  }
  function select(entry: TermRecord | null) {
    if (busy || disabled) return;
    setEditing(entry);
    setForm(
      entry
        ? {
            layer: entry.layer,
            project: entry.project,
            source: entry.source,
            target: entry.target,
            retainSource: entry.retainSource,
            note: entry.note,
            priority: entry.priority,
            enabled: entry.enabled,
            caseSensitive: entry.caseSensitive,
            alternatives: [...entry.alternatives],
          }
        : blankTerm(),
    );
    setAlternatives(entry?.alternatives.join('\n') ?? '');
    setError('');
    setNotice('');
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (lock.current || disabled || busy || !library) return;
    const parsed = alternatives
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    const input: TermInput = {
      ...form,
      source: form.source.trim(),
      target: form.retainSource ? '' : form.target.trim(),
      project: form.layer === 'project' ? form.project.trim() : '',
      note: form.note.trim(),
      alternatives: parsed,
    };
    if (
      !input.source ||
      (input.layer === 'project' && !input.project) ||
      (!input.retainSource && !input.target)
    ) {
      setError('请填写英文术语、项目范围（项目层）及中文译法，或选择保留英文原文。');
      return;
    }
    if (
      !Number.isInteger(input.priority) ||
      input.priority < 0 ||
      input.priority > 100 ||
      parsed.length > PROFESSIONAL_LIMITS.alternatives ||
      parsed.some((value) => value.length > PROFESSIONAL_LIMITS.target)
    ) {
      setError('优先级需为 0–100 的整数；可接受译法最多 8 项，每项最多 160 字符。');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const record = await api<TermRecord>(
        editing ? `/terminology/${encodeURIComponent(editing.id)}` : '/terminology',
        {
          method: editing ? 'PATCH' : 'POST',
          signal: controller.signal,
          body: JSON.stringify({
            ...input,
            ...(editing ? { expectedRevision: editing.revision } : {}),
          }),
        },
      );
      if (!mounted.current || controller.signal.aborted) return;
      setEditing(record);
      setForm({
        layer: record.layer,
        project: record.project,
        source: record.source,
        target: record.target,
        retainSource: record.retainSource,
        note: record.note,
        priority: record.priority,
        enabled: record.enabled,
        caseSensitive: record.caseSensitive,
        alternatives: [...record.alternatives],
      });
      setAlternatives(record.alternatives.join('\n'));
      setLibrary((previous) =>
        previous
          ? {
              ...previous,
              entries: previous.entries.some((entry) => entry.id === record.id)
                ? previous.entries.map((entry) => (entry.id === record.id ? record : entry))
                : [...previous.entries, record],
            }
          : previous,
      );
      setNotice('术语已保存。已有任务的快照与译文不会自动改变；请在任务中预览重新应用。');
      try {
        const next = await api<TermLibrary>('/terminology', { signal: controller.signal });
        if (mounted.current && !controller.signal.aborted) {
          setLibrary(next);
          setReadError('');
        }
      } catch (reason) {
        if (mounted.current && !controller.signal.aborted)
          setReadError(`术语已保存，读取库版本失败：${message(reason)}`);
      }
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) setError(message(reason));
    } finally {
      if (mounted.current && request.current === controller) {
        request.current = null;
        lock.current = false;
        setBusy(false);
        setReading(false);
      }
    }
  }
  const atLimit = (library?.entries.length ?? 0) >= PROFESSIONAL_LIMITS.terms;
  return (
    <details className="professional-panel terminology-manager">
      <summary>
        术语管理{' '}
        <small>
          {library
            ? `${library.entries.length} / ${PROFESSIONAL_LIMITS.terms} 条 · 库版本 ${library.version}`
            : '读取术语库'}
        </small>
      </summary>
      <p className="professional-note">
        匹配的项目术语优先于全局术语；基金与技术术语按显式优先级选择，同优先级的不同译法需人工处理。通用示例只用于演示，不代表基金或行业标准。保存术语不会自动替换任何原文或人工译文。
      </p>
      {readError && (
        <div className="professional-error" role="alert">
          {readError}
        </div>
      )}
      {error && (
        <div className="professional-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="professional-notice" role="status">
          {notice}
        </p>
      )}
      <div className="professional-actions">
        <button type="button" disabled={disabled || busy || reading} onClick={() => void reload()}>
          {reading ? '读取中…' : '重新读取术语库'}
        </button>
        <button
          type="button"
          disabled={disabled || busy || !library || atLimit}
          onClick={() => select(null)}
        >
          新增术语
        </button>
      </div>
      {library && (
        <div className="professional-table-wrap">
          <table className="professional-table" aria-label="术语库">
            <thead>
              <tr>
                <th>层级 / 范围</th>
                <th>英文术语</th>
                <th>译法 / 保留</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {library.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    {LAYERS[entry.layer]}
                    {entry.project && <small>{entry.project}</small>}
                  </td>
                  <td>
                    {entry.source}
                    <small>
                      优先级 {entry.priority} · {entry.caseSensitive ? '区分大小写' : '忽略大小写'}
                    </small>
                  </td>
                  <td>
                    {entry.retainSource ? '保留英文原文' : entry.target}
                    {entry.alternatives.length > 0 && (
                      <small>亦接受：{entry.alternatives.join('；')}</small>
                    )}
                    {entry.note && <small>{entry.note}</small>}
                  </td>
                  <td>{entry.enabled ? '启用' : '停用'}</td>
                  <td>
                    <button
                      type="button"
                      aria-label={`编辑术语 ${entry.source}`}
                      disabled={disabled || busy}
                      onClick={() => select(entry)}
                    >
                      编辑
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {library.entries.length === 0 && (
            <p className="professional-note">术语库为空，可添加经核实的项目、基金或技术术语。</p>
          )}
        </div>
      )}
      <form className="professional-form" onSubmit={(event) => void save(event)}>
        <h3>{editing ? `编辑术语：${editing.source}` : '新增术语'}</h3>
        <fieldset disabled={disabled || busy || !library || (atLimit && !editing)}>
          <div className="professional-form-grid">
            <label>
              术语层级
              <select
                aria-label="术语层级"
                value={form.layer}
                onChange={(event) =>
                  setForm((previous) => ({
                    ...previous,
                    layer: event.target.value as TermLayer,
                    project: event.target.value === 'project' ? previous.project : '',
                  }))
                }
              >
                <option value="project">项目</option>
                <option value="fund">基金</option>
                <option value="technical">技术</option>
              </select>
            </label>
            <label>
              适用项目
              <input
                aria-label="适用项目"
                value={form.project}
                maxLength={PROFESSIONAL_LIMITS.project}
                required={form.layer === 'project'}
                disabled={form.layer !== 'project'}
                onChange={(event) =>
                  setForm((previous) => ({ ...previous, project: event.target.value }))
                }
                placeholder={form.layer === 'project' ? '项目层必填' : '基金和技术术语为全局范围'}
              />
            </label>
            <label>
              英文术语
              <input
                aria-label="英文术语"
                value={form.source}
                maxLength={PROFESSIONAL_LIMITS.source}
                required
                onChange={(event) =>
                  setForm((previous) => ({ ...previous, source: event.target.value }))
                }
              />
            </label>
            <label>
              中文译法
              <input
                aria-label="中文译法"
                value={form.target}
                maxLength={PROFESSIONAL_LIMITS.target}
                required={!form.retainSource}
                disabled={form.retainSource}
                onChange={(event) =>
                  setForm((previous) => ({ ...previous, target: event.target.value }))
                }
              />
            </label>
            <label>
              术语优先级
              <input
                aria-label="术语优先级"
                type="number"
                min={0}
                max={100}
                step={1}
                value={form.priority}
                onChange={(event) =>
                  setForm((previous) => ({ ...previous, priority: Number(event.target.value) }))
                }
              />
            </label>
            <label>
              可接受译法（每行一个）
              <textarea
                aria-label="可接受译法（每行一个）"
                value={alternatives}
                maxLength={PROFESSIONAL_LIMITS.alternatives * (PROFESSIONAL_LIMITS.target + 1)}
                onChange={(event) => setAlternatives(event.target.value)}
              />
            </label>
          </div>
          <label>
            术语备注
            <textarea
              aria-label="术语备注"
              value={form.note}
              maxLength={PROFESSIONAL_LIMITS.note}
              onChange={(event) =>
                setForm((previous) => ({ ...previous, note: event.target.value }))
              }
            />
          </label>
          <div className="professional-checkboxes">
            <label>
              <input
                type="checkbox"
                checked={form.retainSource}
                onChange={(event) =>
                  setForm((previous) => ({
                    ...previous,
                    retainSource: event.target.checked,
                    target: event.target.checked ? '' : previous.target,
                  }))
                }
              />
              保留英文原文
            </label>
            <label>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) =>
                  setForm((previous) => ({ ...previous, enabled: event.target.checked }))
                }
              />
              启用此术语
            </label>
            <label>
              <input
                type="checkbox"
                checked={form.caseSensitive}
                onChange={(event) =>
                  setForm((previous) => ({ ...previous, caseSensitive: event.target.checked }))
                }
              />
              区分大小写
            </label>
          </div>
          <button type="submit" className="primary" disabled={busy || (!editing && atLimit)}>
            {busy ? '保存术语中…' : '保存术语'}
          </button>
        </fieldset>
      </form>
    </details>
  );
}
