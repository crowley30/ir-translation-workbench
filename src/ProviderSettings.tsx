import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PROVIDER_PROTOCOL_OPTIONS,
  type ProviderSettingsConfig,
  type ProviderSettingsSummary,
} from '../shared/provider-settings';
import { professionalApi as api } from './professional-api';
import './provider-settings.css';

const EMPTY: ProviderSettingsConfig = {
  mode: 'mock',
  protocol: 'openai-compatible',
  baseUrl: '',
  model: '',
  credentialRef: '',
};
const STATE_LABEL = {
  mock: '模拟设置',
  unconfigured: '尚未完整配置',
  'configured-unverified': '已保存配置 · 尚未验证',
};
function fields(value: ProviderSettingsSummary): ProviderSettingsConfig {
  return {
    mode: value.mode,
    protocol: value.protocol,
    baseUrl: value.baseUrl,
    model: value.model,
    credentialRef: value.credentialRef,
  };
}

export default function ProviderSettings({ disabled = false }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<ProviderSettingsSummary | null>(null);
  const [form, setForm] = useState<ProviderSettingsConfig>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const mounted = useRef(true);
  const initialLoaded = useRef(false);
  const loadingRef = useRef(false);
  const generation = useRef(0);
  const latestSaved = useRef<ProviderSettingsSummary | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const saveController = useRef<AbortController | null>(null);
  const disposeRequests = useCallback(() => {
    mounted.current = false;
    generation.current++;
    loadingRef.current = false;
    loadController.current?.abort();
    saveController.current?.abort();
  }, []);
  useEffect(() => {
    mounted.current = true;
    return disposeRequests;
  }, [disposeRequests]);
  const loadSettings = useCallback(async () => {
    if (loadingRef.current || lock.current || !mounted.current) return;
    loadingRef.current = true;
    const current = ++generation.current;
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const value = await api<ProviderSettingsSummary>('/provider-settings', {
        signal: controller.signal,
      });
      if (!mounted.current || current !== generation.current) return;
      if (
        !Number.isSafeInteger(value.revision) ||
        value.revision < (latestSaved.current?.revision ?? 0)
      ) {
        throw new Error('读取到较旧的设置版本，当前内容未被替换，请稍后重新加载。');
      }
      latestSaved.current = value;
      initialLoaded.current = true;
      setSaved(value);
      setForm(fields(value));
    } catch (error) {
      if (mounted.current && current === generation.current)
        setError(error instanceof Error ? error.message : '无法读取服务设置。');
    } finally {
      if (current === generation.current) {
        loadingRef.current = false;
        if (mounted.current) setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    // Disclosure toggles only change visibility. A successful first load is kept
    // until the user explicitly requests a replacement of their local draft.
    if (open && !initialLoaded.current) void loadSettings();
  }, [open, loadSettings]);

  async function save() {
    if (disabled || loadingRef.current || lock.current || !latestSaved.current) return;
    lock.current = true;
    const current = ++generation.current;
    loadController.current?.abort();
    setSaving(true);
    setError('');
    setNotice('');
    const controller = new AbortController();
    saveController.current = controller;
    const submitted = { ...form, expectedRevision: latestSaved.current.revision };
    try {
      const value = await api<ProviderSettingsSummary>('/provider-settings', {
        method: 'PUT',
        signal: controller.signal,
        body: JSON.stringify(submitted),
      });
      if (!mounted.current || current !== generation.current) return;
      if (
        value.revision !== submitted.expectedRevision + 1 ||
        value.revision < (latestSaved.current?.revision ?? 0)
      ) {
        throw new Error('保存响应版本未更新，当前草稿已保留，请重新加载确认保存结果。');
      }
      latestSaved.current = value;
      initialLoaded.current = true;
      setSaved(value);
      setForm(fields(value));
      setNotice('设置已保存，尚未验证；本设置页不会发起实际翻译或连接测试。');
    } catch (error) {
      if (mounted.current && current === generation.current)
        setError(error instanceof Error ? error.message : '设置保存未成功，请重新加载后重试。');
    } finally {
      lock.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  const busy = disabled || loading || saving;
  const dirty =
    !!saved &&
    (form.mode !== saved.mode ||
      form.protocol !== saved.protocol ||
      form.baseUrl !== saved.baseUrl ||
      form.model !== saved.model ||
      form.credentialRef !== saved.credentialRef);
  function reloadSettings() {
    if (disabled || loadingRef.current || lock.current) return;
    if (dirty && !window.confirm('当前有未保存的服务设置。重新加载会放弃这些修改，是否继续？'))
      return;
    void loadSettings();
  }
  return (
    <details className="provider-settings" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        翻译服务设置 <span>离线配置 · 未启用真实调用</span>
      </summary>
      <div className="provider-settings-body">
        <div className="provider-settings-explainer">
          <strong>只保存配置，不验证服务可用性。</strong>
          <p>
            地址、模型和服务端凭据变量引用会保存到本机服务。这里不接收密钥值，不发起连接测试，也不会切换当前翻译适配器。
          </p>
        </div>
        {saved && (
          <div className="provider-settings-status" role="status">
            <span>{STATE_LABEL[saved.state]}</span>
            <span>
              {saved.credentialStatus === 'present'
                ? '服务端凭据变量已存在（未验证）'
                : '服务端凭据变量未设置'}
            </span>
            <small>实际调用关闭 · 连通性测试不可用 · 设置版本 {saved.revision}</small>
          </div>
        )}
        {loading && <p role="status">正在读取离线设置…</p>}
        {error && (
          <p className="provider-settings-error" role="alert">
            {error}
          </p>
        )}
        {dirty && (
          <p className="provider-settings-help" role="status">
            有未保存的服务设置；折叠会保留当前草稿，保存后才会持久化。
          </p>
        )}
        {notice && !dirty && (
          <p className="provider-settings-notice" role="status">
            {notice}
          </p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="provider-settings-grid">
            <label>
              设置模式
              <select
                aria-label="服务设置模式"
                value={form.mode}
                disabled={busy}
                onChange={(event) =>
                  setForm((previous) => ({
                    ...previous,
                    mode: event.target.value as ProviderSettingsConfig['mode'],
                  }))
                }
              >
                <option value="mock">模拟开发（Mock）</option>
                <option value="custom">自定义服务（仅保存草稿）</option>
              </select>
            </label>
            <label>
              服务协议
              <select
                aria-label="服务协议"
                value={form.protocol}
                disabled={busy}
                onChange={(event) =>
                  setForm((previous) => ({
                    ...previous,
                    protocol: event.target.value as ProviderSettingsConfig['protocol'],
                  }))
                }
              >
                {PROVIDER_PROTOCOL_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id} disabled={!option.available}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="provider-settings-wide">
              服务基础地址
              <input
                aria-label="服务基础地址"
                type="url"
                autoComplete="off"
                spellCheck={false}
                value={form.baseUrl}
                maxLength={2048}
                disabled={busy}
                placeholder="https://api.example.com/v1"
                onChange={(event) =>
                  setForm((previous) => ({ ...previous, baseUrl: event.target.value }))
                }
              />
            </label>
            <label>
              模型标识
              <input
                aria-label="模型标识"
                autoComplete="off"
                spellCheck={false}
                value={form.model}
                maxLength={120}
                disabled={busy}
                placeholder="服务商提供的模型名"
                onChange={(event) =>
                  setForm((previous) => ({ ...previous, model: event.target.value }))
                }
              />
            </label>
            <label>
              服务端凭据变量引用
              <input
                aria-label="服务端凭据变量引用"
                autoComplete="off"
                spellCheck={false}
                value={form.credentialRef}
                maxLength={100}
                disabled={busy}
                placeholder="由服务端提供的凭据引用"
                onChange={(event) =>
                  setForm((previous) => ({ ...previous, credentialRef: event.target.value }))
                }
              />
            </label>
          </div>
          <p className="provider-settings-help">
            凭据引用仅允许服务端约定的变量名。请在服务端环境变量中配置值，勿把密钥粘贴到任何表单。地址仅进行语法检查，尚未解析
            DNS 或验证公网连通性。
          </p>
          <div className="provider-settings-actions">
            <button type="button" disabled={busy} onClick={reloadSettings}>
              重新加载设置
            </button>
            <button className="primary" disabled={busy || !saved} type="submit">
              {saving ? '正在保存设置…' : '保存离线设置'}
            </button>
          </div>
        </form>
      </div>
    </details>
  );
}
