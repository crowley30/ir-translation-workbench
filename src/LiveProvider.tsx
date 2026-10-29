import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveProviderStatus, StartLiveProvider } from '../shared/live-provider';
import { findOpenAIModel } from '../shared/openai-models';
import { professionalApi as api } from './professional-api';
import './provider-settings.css';

const MODE_LABEL: Record<LiveProviderStatus['mode'], string> = {
  mock: '模拟模式',
  'real-disabled': '真实调用已关闭',
  live: '真实调用已启用',
};
function money(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(6)}`;
}
function budgetAmount(value: string): number | null {
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}
function validStatus(value: LiveProviderStatus): boolean {
  if (!value || !['mock', 'real-disabled', 'live'].includes(value.mode) || !value.budget)
    return false;
  const amounts = [
    value.settingsRevision,
    value.budget.budgetMicros,
    value.budget.spentMicros,
    value.budget.reservedMicros,
    value.budget.remainingMicros,
    value.budget.operatorCapMicros,
  ];
  return (
    amounts.every((amount) => Number.isSafeInteger(amount) && amount >= 0) &&
    typeof value.reason === 'string' &&
    typeof value.model === 'string' &&
    typeof value.operatorEnabled === 'boolean'
  );
}

interface Props {
  disabled?: boolean;
  onStatusChange?: (value: LiveProviderStatus | null) => void;
  onEmergencyStop?: () => void;
}
export default function LiveProvider({ disabled = false, onStatusChange, onEmergencyStop }: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<LiveProviderStatus | null>(null);
  const [budget, setBudget] = useState('');
  const [outputTokens, setOutputTokens] = useState('4096');
  const [costsAccepted, setCostsAccepted] = useState(false);
  const [dataAccepted, setDataAccepted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const lock = useRef(false);
  const readLock = useRef(false);
  const emergencyLock = useRef(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const publishStatus = useCallback(
    (value: LiveProviderStatus | null) => {
      setStatus(value);
      onStatusChange?.(value);
    },
    [onStatusChange],
  );
  const disposeRequests = useCallback(() => {
    mounted.current = false;
    generation.current++;
    readLock.current = false;
    lock.current = false;
    emergencyLock.current = false;
    controller.current?.abort();
  }, []);
  useEffect(() => {
    mounted.current = true;
    return disposeRequests;
  }, [disposeRequests]);
  const readStatus = useCallback(
    async (preserveError = false) => {
      if (!mounted.current || lock.current || readLock.current || emergencyLock.current) return;
      readLock.current = true;
      const current = ++generation.current;
      const request = new AbortController();
      controller.current?.abort();
      controller.current = request;
      setLoading(true);
      publishStatus(null);
      if (!preserveError) {
        setError('');
        setNotice('');
      }
      try {
        const value = await api<LiveProviderStatus>('/live-provider', { signal: request.signal });
        if (!mounted.current || current !== generation.current) return;
        if (!validStatus(value)) throw new Error('服务返回的调用状态无效，请重新读取。');
        publishStatus(value);
      } catch (problem) {
        if (mounted.current && current === generation.current) {
          publishStatus(null);
          setError(problem instanceof Error ? problem.message : '无法读取调用状态。');
        }
      } finally {
        if (current === generation.current) {
          readLock.current = false;
          if (mounted.current) setLoading(false);
        }
      }
    },
    [publishStatus],
  );
  useEffect(() => {
    // Reading this local control endpoint cannot contact the provider. Always
    // synchronize on mount, including when the disclosure remains closed.
    void readStatus();
  }, [readStatus]);

  const budgetMicros = budgetAmount(budget);
  const tokens = /^\d{1,5}$/.test(outputTokens) ? Number(outputTokens) : 0;
  const model = findOpenAIModel(status?.model ?? '');
  const maxTokens = model?.maxOutputTokens ?? 8192;
  const existingLimit = status?.budget.budgetMicros ?? 0;
  const amountAllowed =
    budgetMicros !== null &&
    budgetMicros <= (status?.budget.operatorCapMicros ?? 0) &&
    (!existingLimit || budgetMicros === existingLimit);
  const canStart =
    !!status &&
    status.mode !== 'live' &&
    status.operatorEnabled &&
    status.credentialStatus === 'present' &&
    status.provider === 'openai-responses' &&
    !!model &&
    !status.budget.overrun &&
    (!existingLimit || status.budget.remainingMicros > 0) &&
    amountAllowed &&
    tokens >= 256 &&
    tokens <= maxTokens &&
    costsAccepted &&
    dataAccepted;
  const busy = disabled || loading || !!action;

  async function changeMode(kind: 'start' | 'stop' | 'mock') {
    const emergency = kind !== 'start';
    if (
      emergency
        ? emergencyLock.current
        : disabled || lock.current || readLock.current || !status || !canStart
    )
      return;
    if (emergency) {
      emergencyLock.current = true;
      onEmergencyStop?.();
      // Stops may preempt a pending status read or start response. Aborting the
      // wait is not a claim that the previous server mutation was rolled back.
      readLock.current = false;
      lock.current = false;
      setLoading(false);
    } else lock.current = true;
    const current = ++generation.current;
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    publishStatus(null);
    setAction(kind);
    setError('');
    setNotice('');
    const body: StartLiveProvider | Record<string, never> =
      kind === 'start'
        ? {
            expectedRevision: status!.settingsRevision,
            acknowledgeCosts: true,
            confirmDataTransfer: true,
            budgetMicros: budgetMicros!,
            maxOutputTokens: tokens,
          }
        : {};
    let reconcile = false;
    try {
      const value = await api<LiveProviderStatus>(`/live-provider/${kind}`, {
        method: 'POST',
        signal: request.signal,
        body: JSON.stringify(body),
      });
      if (!mounted.current || current !== generation.current) return;
      if (!validStatus(value)) throw new Error('服务返回的调用状态无效，请重新读取确认结果。');
      publishStatus(value);
      setCostsAccepted(false);
      setDataAccepted(false);
      setNotice(
        kind === 'start'
          ? '真实调用已启用，但尚未发送翻译或连接测试。请在任务中明确发起翻译；结果仍需人工复核。'
          : kind === 'stop'
            ? '已停止真实调用并取消运行中的任务。未知用量的预留不会释放；停止不代表未计费。'
            : '已切回模拟模式并取消运行中的任务。已有真实任务保留其模式，累计预算不会重置。',
      );
    } catch (problem) {
      if (mounted.current && current === generation.current) {
        publishStatus(null);
        setError(
          problem instanceof Error
            ? problem.message
            : '调用状态更改未成功，正在重新读取确认；当前表单已保留。',
        );
        reconcile = true;
      }
    } finally {
      if (current === generation.current) {
        lock.current = false;
        emergencyLock.current = false;
        if (mounted.current) {
          setAction('');
          if (reconcile) void readStatus(true);
        }
      }
    }
  }
  return (
    <details className="live-provider" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        真实调用控制{' '}
        <span>
          {status
            ? `调用状态：${MODE_LABEL[status.mode]}`
            : loading
              ? '调用状态未知 · 正在同步'
              : '调用状态未知 · 请重新读取'}
        </span>
      </summary>
      <div className="provider-settings-body">
        <div className="provider-settings-explainer">
          <strong>启用不发请求；任务翻译才可能产生费用。</strong>
          <p>
            只有服务端操作员允许、凭据存在、官方模型和累计预算均就绪时，才可明确启用。页面加载和保存设置不会连接
            OpenAI。自定义兼容地址目前只保存配置。
          </p>
        </div>
        {loading && <p role="status">正在读取调用状态…</p>}
        {open && status && (
          <>
            <div className="provider-settings-status" role="status">
              <span>{MODE_LABEL[status.mode]}</span>
              <span>当前模型：{status.model || '未选择'}</span>
              <span>操作员开关：{status.operatorEnabled ? '已允许' : '关闭'}</span>
              <span>
                服务端凭据：{status.credentialStatus === 'present' ? '存在 · 未验证' : '未设置'}
              </span>
              <small>{status.reason}</small>
            </div>
            <dl className="live-budget" aria-label="累计预算状态">
              <div>
                <dt>操作员累计上限</dt>
                <dd>{money(status.budget.operatorCapMicros)}</dd>
              </div>
              <div>
                <dt>本轮累计上限</dt>
                <dd>{money(status.budget.budgetMicros)}</dd>
              </div>
              <div>
                <dt>已对账费用</dt>
                <dd>{money(status.budget.spentMicros)}</dd>
              </div>
              <div>
                <dt>进行中或未知用量预留</dt>
                <dd>{money(status.budget.reservedMicros)}</dd>
              </div>
              <div>
                <dt>剩余可预留</dt>
                <dd>{money(status.budget.remainingMicros)}</dd>
              </div>
            </dl>
          </>
        )}
        {error && (
          <p className="provider-settings-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="provider-settings-notice" role="status">
            {notice}
          </p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void changeMode('start');
          }}
        >
          <div className="provider-settings-grid">
            <label>
              本轮累计预算（美元）
              <input
                aria-label="本轮累计预算（美元）"
                inputMode="decimal"
                autoComplete="off"
                value={budget}
                maxLength={14}
                placeholder="请先确认本轮总预算"
                disabled={busy || status?.mode === 'live'}
                onChange={(event) => setBudget(event.target.value)}
              />
            </label>
            <label>
              每段最大输出 token
              <input
                aria-label="每段最大输出 token"
                inputMode="numeric"
                value={outputTokens}
                maxLength={5}
                disabled={busy || status?.mode === 'live'}
                onChange={(event) => setOutputTokens(event.target.value)}
              />
            </label>
          </div>
          <p className="provider-settings-help">
            预算覆盖本轮所有段落、并发和重试，每次发送前先预留输入保守上界与最大输出费用。失败、取消、超时或未知用量会保留费用预留；重新启用不重置累计金额。已有累计上限时须填写相同金额。每段至少
            256、最多 {maxTokens.toLocaleString()} 输出
            token。金额是读取时按保守费率计算的估算，非供应商账单；请刷新状态查看最新消耗。应用估算不能保证供应商账单绝不超额。
          </p>
          <div className="live-consents">
            <label>
              <input
                type="checkbox"
                checked={costsAccepted}
                disabled={busy || status?.mode === 'live'}
                onChange={(event) => setCostsAccepted(event.target.checked)}
              />
              我确认本轮累计费用上限，包含全部请求和重试
            </label>
            <label>
              <input
                type="checkbox"
                checked={dataAccepted}
                disabled={busy || status?.mode === 'live'}
                onChange={(event) => setDataAccepted(event.target.checked)}
              />
              我同意将所选任务的原文与必要上下文发送给 OpenAI
            </label>
          </div>
          <div className="provider-settings-actions live-actions">
            <button type="button" disabled={busy} onClick={() => void readStatus()}>
              刷新调用状态
            </button>
            <button
              type="button"
              disabled={action === 'stop' || action === 'mock'}
              onClick={() => void changeMode('stop')}
            >
              停止真实调用
            </button>
            <button
              type="button"
              disabled={action === 'stop' || action === 'mock'}
              onClick={() => void changeMode('mock')}
            >
              切回模拟模式
            </button>
            <button type="submit" className="primary" disabled={busy || !canStart}>
              {action === 'start' ? '正在启用…' : '启用真实翻译'}
            </button>
          </div>
        </form>
        <p className="provider-settings-help">
          修改服务设置后请刷新此处状态。这里没有密钥输入或连通性测试；凭据仅由服务端安全配置。关闭浏览器不等于停止服务端调用，请使用停止按钮。
        </p>
      </div>
    </details>
  );
}
