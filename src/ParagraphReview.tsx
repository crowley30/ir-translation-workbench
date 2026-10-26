import { useEffect, useRef, useState } from 'react';
import { professionalApi as api } from './professional-api';
import type { Task } from '../shared/types';
import type { ReviewFinding } from '../shared/professional';

interface Props {
  task: Task;
  paragraphId: string;
  dirty: boolean;
  disabled: boolean;
  onChanged(task: Task): void;
}
function Finding({ finding }: { finding: ReviewFinding }) {
  return (
    <li className="professional-finding">
      <strong>{finding.reason}</strong>
      <small>
        {finding.paragraphLocation} ·{' '}
        {finding.certainty === 'uncertain' ? '不确定，需人工判断' : '规则提示'}
      </small>
      {finding.source && (
        <p>
          原文位置 [{finding.source.start}, {finding.source.end})：<q>{finding.source.text}</q>
        </p>
      )}
      {finding.translation && (
        <p>
          译文位置 [{finding.translation.start}, {finding.translation.end})：
          <q>{finding.translation.text}</q>
        </p>
      )}
      {!finding.source && !finding.translation && <p>此提示作用于整个段落，请对照原译文核实。</p>}
    </li>
  );
}
export default function ParagraphReview({ task, paragraphId, dirty, disabled, onChanged }: Props) {
  const paragraph = task.paragraphs.find((item) => item.id === paragraphId);
  const professional = task.professional;
  const snapshotId = professional?.snapshot.id ?? '';
  const findings =
    professional?.review.findings.filter((item) => item.paragraphId === paragraphId) ?? [];
  const approval = professional?.review.approvals.find(
    (item) =>
      item.paragraphId === paragraphId &&
      item.revision === paragraph?.revision &&
      item.snapshotId === snapshotId,
  );
  const invalidated = professional?.review.events.some(
    (item) => item.paragraphId === paragraphId && item.type === 'invalidated',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const lock = useRef(false);
  const current = useRef({ id: task.id, paragraphId, revision: paragraph?.revision, snapshotId });
  current.current = { id: task.id, paragraphId, revision: paragraph?.revision, snapshotId };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    controller.current?.abort();
    controller.current = null;
    lock.current = false;
    setBusy(false);
    setError('');
    setNotice('');
    return () => {
      controller.current?.abort();
    };
  }, [task.id, paragraphId, paragraph?.revision, snapshotId]);
  const canReview =
    !!professional &&
    !!paragraph &&
    paragraph.status === 'done' &&
    !!paragraph.translation.trim() &&
    !dirty &&
    !disabled &&
    task.status !== 'running';
  async function confirm(confirmed: boolean) {
    if (!canReview || lock.current || !paragraph) return;
    const target = { ...current.current };
    const request = new AbortController();
    controller.current = request;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const updated = await api<Task>(`/tasks/${encodeURIComponent(target.id)}/review`, {
        method: 'POST',
        signal: request.signal,
        body: JSON.stringify({
          paragraphId: target.paragraphId,
          expectedRevision: target.revision,
          snapshotId: target.snapshotId,
          confirmed,
        }),
      });
      if (
        !mounted.current ||
        request.signal.aborted ||
        current.current.id !== target.id ||
        current.current.paragraphId !== target.paragraphId
      )
        return;
      if (
        current.current.revision !== target.revision ||
        current.current.snapshotId !== target.snapshotId
      ) {
        setError('本段译文或术语快照已更新，请重新检查后再确认。');
        return;
      }
      onChanged(updated);
      setNotice(
        confirmed
          ? '已记录人工复核确认，仅对当前已保存版本和术语快照有效。'
          : '已撤销本段人工复核确认。',
      );
    } catch (reason) {
      if (
        mounted.current &&
        !request.signal.aborted &&
        current.current.id === target.id &&
        current.current.paragraphId === target.paragraphId
      )
        setError(reason instanceof Error ? reason.message : '人工复核记录未保存，请重试。');
    } finally {
      if (mounted.current && controller.current === request) {
        controller.current = null;
        lock.current = false;
        setBusy(false);
      }
    }
  }
  if (!paragraph) return null;
  return (
    <details className="paragraph-review">
      <summary>
        检查与人工复核{' '}
        <span>
          {findings.length} 项提示 · {approval && !dirty ? '当前保存版本已人工确认' : '待人工复核'}
        </span>
      </summary>
      <p className="professional-note">
        检查仅提示可能的数字、币种、日期或术语差异，不自动修订。没有提示也不代表翻译质量通过；人工确认只记录您的明确操作。
      </p>
      {findings.length ? (
        <ul className="professional-findings">
          {findings.map((finding) => (
            <Finding key={finding.id} finding={finding} />
          ))}
        </ul>
      ) : (
        <p className="professional-note">当前规则未发现差异，仍需人工核实原意和完整性。</p>
      )}
      {approval && !dirty && (
        <p className="professional-approved">
          已于 {new Date(approval.confirmedAt).toLocaleString('zh-CN')} 人工确认此保存版本（段落版本{' '}
          {approval.revision}）。
        </p>
      )}
      {dirty && (
        <p className="professional-note">
          当前有未保存修改，请先保存再人工复核。此前的确认仅对应已保存版本。
        </p>
      )}
      {!approval && invalidated && (
        <p className="professional-note">
          译文或术语快照已变化，之前的人工确认已失效，请重新复核。
        </p>
      )}
      {!professional && (
        <p className="professional-note">任务尚未建立术语快照，暂不能记录本段复核。</p>
      )}
      {error && (
        <p role="alert" className="professional-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="professional-notice">
          {notice}
        </p>
      )}
      <button type="button" disabled={!canReview || busy} onClick={() => void confirm(!approval)}>
        {busy ? '保存复核记录中…' : approval ? '撤销本段人工确认' : '人工确认已复核此段'}
      </button>
    </details>
  );
}
