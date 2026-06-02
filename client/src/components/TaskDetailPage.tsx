import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Link, useParams, useNavigate, useLocation } from 'react-router-dom';
import { MoreHorizontal, Trash2, Loader2, Pencil, Check, GitBranch, AlertTriangle, CheckCircle2, Clock, ArrowRight, MessageSquareText, X, Activity, ExternalLink, GitPullRequest, RefreshCw, Bot, Link2, Save, FileText, Radio, ListTree } from 'lucide-react';

import { DeleteConfirmModal } from './DeleteConfirmModal';
import { StatusIcon } from './StatusIcon';
import { useStore, optimisticMoveTask } from '../lib/store';
import { toast } from 'sonner';
import { deleteTask, fetchSubtasks, fetchTask, fetchTaskKanban, fetchTaskKanbanLogs, fetchTaskGitHubStatus, linkTaskGitHubPr, refreshTaskGitHubStatus, syncTaskKanbanSubtasks, syncTaskKanbanSubtasksFromChat, patchTask, moveTask, markTaskViewed, ApiError } from '../lib/api';
import { DELEGATION_STATUSES, TASK_STATUSES } from '@shared/types';
import { STATUS_META } from '../lib/constants';
import { timeAgo } from '../lib/format';
import { isEditableTarget } from '../lib/keyboard';
import { TaskChat } from './TaskChat';
import { RenameReveal, useRenameAnimation } from './RenameTitle';
import type { AgentRunSettings } from '../lib/api';
import type { DelegationStatus, KanbanLogsResponse, KanbanTaskResponse, Task, TaskStatus } from '@shared/types';


const DELEGATION_META: Record<DelegationStatus, { label: string; icon: React.ReactNode; tint: string }> = {
  queued: { label: 'Queued', icon: <Clock size={11} strokeWidth={2.5} />, tint: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300' },
  running: { label: 'Running', icon: <Loader2 size={11} strokeWidth={2.5} className="animate-spin" />, tint: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300' },
  review: { label: 'In review', icon: <CheckCircle2 size={11} strokeWidth={2.5} />, tint: 'border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-900/70 dark:bg-purple-950/30 dark:text-purple-300' },
  blocked: { label: 'Blocked', icon: <AlertTriangle size={11} strokeWidth={2.5} />, tint: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-300' },
  done: { label: 'Done', icon: <CheckCircle2 size={11} strokeWidth={2.5} />, tint: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/30 dark:text-emerald-300' },
};

const GITHUB_CHECK_TINTS: Record<string, string> = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/30 dark:text-emerald-300',
  failure: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-300',
  pending: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300',
  unknown: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
};

interface GitHubStatusState {
  prUrl: string | null;
  prNumber: number | null;
  prState: string | null;
  headRef: string | null;
  headSha: string | null;
  checksStatus: string | null;
  checksSummary: string | null;
  checksUpdatedAt: number | null;
  refreshing: boolean;
  linking: boolean;
  syncError: string | null;
}

function DelegationBadge({ status }: { status: DelegationStatus | null }) {
  if (!status || !DELEGATION_STATUSES.includes(status)) return null;
  const meta = DELEGATION_META[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.tint}`}>
      {meta.icon}
      {meta.label}
    </span>
  );
}

function formatPayload(payload: Record<string, unknown>): string {
  const compact = JSON.stringify(payload);
  if (!compact || compact === '{}') return '—';
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function formatKanbanEventLabel(kind: string): string {
  return kind
    .replace(/^task\./, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function payloadPreview(payload: Record<string, unknown>): string | null {
  const direct = payload.summary ?? payload.message ?? payload.status ?? payload.outcome ?? payload.reason ?? payload.error;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  if (typeof direct === 'number' || typeof direct === 'boolean') return String(direct);
  const compact = formatPayload(payload);
  return compact === '—' ? null : compact;
}

function shortId(value: string | null | undefined, length = 8): string | null {
  if (!value) return null;
  return value.length > length ? value.slice(0, length) : value;
}

function KanbanPanel({
  info,
  logs,
  github,
  onGitHubRefresh,
  onGitHubEdit,
}: {
  info: KanbanTaskResponse | null;
  logs: KanbanLogsResponse | null;
  github: GitHubStatusState;
  onGitHubRefresh: () => void;
  onGitHubEdit: () => void;
}) {
  if (!info?.kanban_id) return null;
  const kanban = info.kanban;
  const latestRun = logs?.runs?.[0] ?? null;
  const latestComment = logs?.comments?.find((comment) => comment.body?.trim()) ?? logs?.comments?.[0] ?? null;
  const eventRows = logs?.logs ?? [];
  const latestEvent = eventRows[0] ?? null;
  const profile = kanban?.assignee ?? info.delegation_profile;
  const hasGitHub = Boolean(github.prNumber || github.prUrl || github.checksStatus);
  const prStateLabel = github.prState ? (github.prState === 'OPEN' ? 'Open' : github.prState === 'MERGED' ? 'Merged' : 'Closed') : null;
  const checkTint = GITHUB_CHECK_TINTS[github.checksStatus ?? 'unknown'] ?? GITHUB_CHECK_TINTS.unknown;
  const latestPreview = latestComment?.body ?? (latestEvent ? payloadPreview(latestEvent.payload) : null);

  return (
    <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white/90 shadow-sm backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80">
      <div className="flex min-w-0 flex-col gap-2 px-3 py-2 text-[11px] sm:px-3.5">
        <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto overscroll-x-contain pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-purple-200 bg-purple-50 px-2 py-1 font-semibold uppercase tracking-wide text-purple-700 dark:border-purple-900/70 dark:bg-purple-950/40 dark:text-purple-300">
            <Activity size={10} strokeWidth={2.5} />
            Kanban live
          </span>
          <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-1 font-mono font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {shortId(info.kanban_id, 10)}
          </span>
          {profile && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-zinc-200 bg-white px-2 py-1 font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
              <Bot size={10} strokeWidth={2.5} />
              {profile}
            </span>
          )}
          {kanban?.status && (
            <span className={`shrink-0 rounded-full border px-2 py-1 font-semibold ${kanbanStatusTint(kanban.status)}`}>
              {kanban.status}
            </span>
          )}
          {latestRun && (
            <span className="shrink-0 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-1 font-mono font-medium text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-300">
              run #{latestRun.run_id} {latestRun.status}
            </span>
          )}
          {(hasGitHub || github.syncError) && (
            <>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-1 font-semibold text-blue-700 dark:border-blue-900/70 dark:bg-blue-950/40 dark:text-blue-300">
                <GitPullRequest size={10} strokeWidth={2.5} />
                {github.prNumber ? `PR #${github.prNumber}` : 'PR'}
              </span>
              {prStateLabel && (
                <span className="shrink-0 rounded-full border border-zinc-200 bg-white px-2 py-1 font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                  {prStateLabel}
                </span>
              )}
              {(github.checksStatus || hasGitHub) && (
                <span className={`shrink-0 rounded-full border px-2 py-1 font-semibold ${checkTint}`}>
                  {github.checksStatus ?? 'unknown'}
                </span>
              )}
            </>
          )}
          {github.syncError && <span className="shrink-0 text-red-500 dark:text-red-400">{github.syncError}</span>}
        </div>

        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-zinc-100 pt-2 dark:border-zinc-800/70">
          <div className="min-w-0 text-zinc-500 dark:text-zinc-400">
            <div className="truncate font-medium text-zinc-700 dark:text-zinc-200">
              {latestEvent ? formatKanbanEventLabel(latestEvent.event_kind) : 'No events yet'}
            </div>
            {latestPreview && (
              <div className="mt-0.5 line-clamp-2 break-words leading-snug">
                {latestPreview}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={onGitHubRefresh}
              disabled={github.refreshing}
              title="Refresh GitHub status"
              className="inline-flex min-h-[32px] shrink-0 items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2 font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {github.refreshing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} strokeWidth={2.5} />}
              Sync
            </button>
            {github.prUrl && (
              <a
                href={github.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[32px] shrink-0 items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2 font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <ExternalLink size={12} strokeWidth={2.5} />
                Open
              </a>
            )}
            <button
              type="button"
              onClick={onGitHubEdit}
              className="inline-flex min-h-[32px] shrink-0 items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2 font-semibold text-blue-700 transition-colors hover:border-blue-300 hover:bg-blue-100 dark:border-blue-900/70 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-950/70"
            >
              <Link2 size={12} strokeWidth={2.5} />
              {hasGitHub ? 'Edit' : 'Link PR'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function TranscriptLog({ taskId, hasKanban, refreshKey, compact = false }: { taskId: string; hasKanban: boolean; refreshKey: number; compact?: boolean }) {
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!hasKanban) {
      setContent('');
      setError(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    fetch(`/api/tasks/${encodeURIComponent(taskId)}/kanban/transcript`, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (res) => {
        const text = await res.text();
        if (!res.ok) throw new Error(text.trim() || `HTTP ${res.status}`);
        return text;
      })
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setError(null);
      })
      .catch((err) => {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Transcript unavailable');
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [taskId, hasKanban, refreshKey]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [content]);

  if (!hasKanban) return null;

  return (
    <section className={`${compact ? 'flex-[0.45]' : 'flex-1'} flex min-h-0 flex-col overflow-hidden rounded-2xl border border-amber-100 bg-zinc-950 shadow-sm shadow-amber-100/50 dark:border-amber-900/40 dark:shadow-black/20`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-amber-100 bg-white px-3 py-2 dark:border-amber-900/40 dark:bg-zinc-900">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-300">
          <FileText size={12} strokeWidth={2.5} />
          Worker Transcript
        </span>
        <span className="text-xs text-zinc-400">live log from Hermes worker</span>
      </div>
      <pre
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-zinc-950 p-3 font-mono text-[11px] leading-5 text-zinc-200"
      >
        {error ? `Transcript unavailable: ${error}` : content || 'Loading worker transcript...'}
      </pre>
    </section>
  );
}

function GitHubPanel({
  status,
  onRefresh,
  prDraft,
  onPrDraftChange,
  onLink,
  compact = false,
  openEditorSignal = 0,
}: {
  status: GitHubStatusState;
  onRefresh: () => void;
  prDraft: string;
  onPrDraftChange: (value: string) => void;
  onLink: (nextPrUrl?: string | null) => void;
  compact?: boolean;
  openEditorSignal?: number;
}) {
  const [showEditor, setShowEditor] = useState(false);
  const hasGitHub = Boolean(status.prNumber || status.prUrl || status.checksStatus);
  const prStateLabel = status.prState ? (status.prState === 'OPEN' ? 'Open' : status.prState === 'MERGED' ? 'Merged' : 'Closed') : null;
  const checkTint = GITHUB_CHECK_TINTS[status.checksStatus ?? 'unknown'] ?? GITHUB_CHECK_TINTS.unknown;
  const summary = hasGitHub
    ? status.checksSummary || 'PR linked and synced.'
    : 'No PR linked yet.';

  useEffect(() => {
    if (openEditorSignal > 0) setShowEditor(true);
  }, [openEditorSignal]);

  const handleLinkAndClose = () => {
    onLink();
    if (prDraft.trim()) setShowEditor(false);
  };

  return (
    <section className={compact ? "contents" : "rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/80"}>
      {!compact && (
      <div className="flex flex-col gap-3 text-xs">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700 dark:border-blue-900/70 dark:bg-blue-950/40 dark:text-blue-300">
            <GitPullRequest size={12} strokeWidth={2.5} />
            {status.prNumber ? `PR #${status.prNumber}` : 'GitHub PR'}
          </span>
          {prStateLabel && (
            <span className="rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
              {prStateLabel}
            </span>
          )}
          {(status.checksStatus || hasGitHub) && (
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${checkTint}`}>
              {status.checksStatus ?? 'unknown'}
            </span>
          )}
          {status.headRef && (
            <span className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
              {status.headRef}{status.headSha ? ` @ ${status.headSha.slice(0, 7)}` : ''}
            </span>
          )}
          <span className="min-w-0 truncate text-[11px] text-zinc-500 dark:text-zinc-400">{summary}</span>
          {status.syncError && <span className="text-[11px] text-red-500 dark:text-red-400">{status.syncError}</span>}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={onRefresh}
            disabled={status.refreshing}
            title="Refresh GitHub status"
            className="inline-flex h-7 items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2 text-[11px] font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {status.refreshing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} strokeWidth={2.5} />}
            Sync
          </button>
          {status.prUrl && (
            <a
              href={status.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2 text-[11px] font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <ExternalLink size={12} strokeWidth={2.5} />
              Open
            </a>
          )}
          <button
            type="button"
            onClick={() => setShowEditor(true)}
            className="inline-flex h-7 items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2 text-[11px] font-semibold text-blue-700 transition-colors hover:border-blue-300 hover:bg-blue-100 dark:border-blue-900/70 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-950/70"
          >
            <Link2 size={12} strokeWidth={2.5} />
            {hasGitHub ? 'Edit' : 'Link'}
          </button>
        </div>
      </div>
      )}

      {showEditor && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm" onMouseDown={() => setShowEditor(false)}>
          <div className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950" onMouseDown={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Link GitHub PR</h2>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Paste or clear the PR URL. AgentControl will sync state and checks after saving.</p>
              </div>
              <button
                type="button"
                onClick={() => setShowEditor(false)}
                className="rounded-lg p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                aria-label="Close GitHub PR editor"
              >
                <X size={16} strokeWidth={2.5} />
              </button>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Link2 size={13} strokeWidth={2.5} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
                <input
                  value={prDraft}
                  onChange={(e) => onPrDraftChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleLinkAndClose();
                    }
                  }}
                  placeholder="https://github.com/owner/repo/pull/123"
                  className="h-10 w-full rounded-xl border border-zinc-200 bg-zinc-50 pl-8 pr-3 text-sm text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-blue-800 dark:focus:ring-blue-950/50"
                  autoFocus
                />
              </div>
              <button
                type="button"
                onClick={handleLinkAndClose}
                disabled={status.linking}
                className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-3 text-xs font-semibold text-blue-700 transition-colors hover:border-blue-300 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-blue-900/70 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-950/70"
              >
                {status.linking ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} strokeWidth={2.5} />}
                Save
              </button>
            </div>
            <button
              type="button"
              onClick={() => { onPrDraftChange(''); onLink(''); setShowEditor(false); }}
              className="mt-3 text-[11px] font-medium text-zinc-500 transition-colors hover:text-red-600 dark:text-zinc-400 dark:hover:text-red-400"
            >
              Clear linked PR
            </button>
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}

function isKanbanSubtask(subtask: Task): boolean {
  return Boolean(subtask.hermes_kanban_task_id || subtask.external_source === 'hermes-kanban-sync');
}

function getEffectiveDelegationStatus(subtask: Task): DelegationStatus | null {
  if (subtask.delegation_status) return subtask.delegation_status;
  if (subtask.status === 'done') return 'done';
  if (subtask.status === 'in_review') return 'review';
  if (subtask.status === 'in_progress') return 'running';
  return null;
}

function kanbanStatusTint(status: string | null): string {
  switch (status) {
    case 'done':
    case 'review':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/30 dark:text-emerald-300';
    case 'running':
      return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300';
    case 'blocked':
      return 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-300';
    default:
      return 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300';
  }
}

function sortSubtasksForTriage(subtasks: Task[]): Task[] {
  const rank = (subtask: Task) => {
    const effectiveStatus = getEffectiveDelegationStatus(subtask);
    if (effectiveStatus === 'blocked') return 0;
    if (effectiveStatus === 'running') return 1;
    if (effectiveStatus === 'review') return 2;
    if (subtask.status === 'todo') return 3;
    if (effectiveStatus === 'done') return 4;
    return 5;
  };
  return [...subtasks].sort((a, b) => rank(a) - rank(b) || b.updated_at - a.updated_at);
}

function SubtaskRow({ subtask }: { subtask: Task }) {
  const statusMeta = STATUS_META[subtask.status];
  const kanbanBacked = isKanbanSubtask(subtask);
  const effectiveDelegationStatus = getEffectiveDelegationStatus(subtask);
  const profile = subtask.delegation_profile ?? subtask.assignee;
  const prLabel = subtask.github_pr_number ? `PR #${subtask.github_pr_number}` : null;

  return (
    <Link
      to={`/tasks/${subtask.id}`}
      className="group block rounded-xl border border-zinc-200 bg-white p-2.5 shadow-sm shadow-zinc-200/40 transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900/90 dark:shadow-black/20 dark:hover:border-zinc-700"
    >
      <div className="mb-2 flex items-start gap-2">
        <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border ${kanbanBacked ? 'border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-900/70 dark:bg-purple-950/30 dark:text-purple-300' : 'border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400'}`}>
          {kanbanBacked ? <Bot size={13} strokeWidth={2.5} /> : <GitBranch size={13} strokeWidth={2.5} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-1 text-sm font-semibold leading-5 text-zinc-900 group-hover:text-zinc-950 dark:text-zinc-100 dark:group-hover:text-white">
            {subtask.title}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {subtask.hermes_kanban_task_id && (
              <span className="rounded-md bg-purple-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-purple-700 dark:bg-purple-950/60 dark:text-purple-300">
                {subtask.hermes_kanban_task_id}
              </span>
            )}
            {profile && (
              <span className="rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
                {profile}
              </span>
            )}
            {prLabel && (
              <span className="rounded-md border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 dark:border-blue-900/70 dark:bg-blue-950/30 dark:text-blue-300">
                {prLabel}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusMeta.tint}`}>
          <StatusIcon status={subtask.status} />
          {statusMeta.label}
        </span>
        <DelegationBadge status={effectiveDelegationStatus} />
        {kanbanBacked && (
          <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${kanbanStatusTint(effectiveDelegationStatus)}`}>
            <Activity size={10} strokeWidth={2.5} />
            Kanban
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-zinc-400 dark:text-zinc-500">
        <span>{timeAgo(subtask.updated_at)}</span>
        <span className="inline-flex items-center gap-0.5 font-medium text-zinc-500 group-hover:text-zinc-700 dark:text-zinc-400 dark:group-hover:text-zinc-200">
          <MessageSquareText size={10} strokeWidth={2.5} />
          Chat & logs
          <ArrowRight size={10} strokeWidth={2.5} className="transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}

function SubtasksSidebar({ subtasks, live, className = '' }: { subtasks: Task[]; live?: boolean; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const stats = subtasks.reduce(
    (acc, subtask) => {
      const effectiveStatus = getEffectiveDelegationStatus(subtask);
      if (effectiveStatus === 'done') acc.done += 1;
      if (effectiveStatus === 'running') acc.running += 1;
      if (effectiveStatus === 'blocked') acc.blocked += 1;
      if (effectiveStatus === 'review') acc.review += 1;
      return acc;
    },
    { done: 0, running: 0, blocked: 0, review: 0 },
  );
  const doneCount = stats.done;
  const runningCount = stats.running;
  const blockedCount = stats.blocked;
  const reviewCount = stats.review;
  const activeCount = runningCount + reviewCount + blockedCount;
  const kanbanCount = subtasks.filter(isKanbanSubtask).length;
  const progress = subtasks.length > 0 ? Math.round((activeCount / subtasks.length) * 100) : 0;

  const visibleSubtasks = sortSubtasksForTriage(subtasks);

  return (
    <section className={`flex min-h-0 flex-[1.65] flex-col rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900/80 ${className}`}>
      <div className="shrink-0 border-b border-zinc-200 px-3 py-3 dark:border-zinc-800">
        <div className="mb-3 flex items-center gap-3">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-purple-200 bg-purple-50 text-purple-700 shadow-sm dark:border-purple-900/70 dark:bg-purple-950/30 dark:text-purple-300">
            <GitBranch size={15} strokeWidth={2.5} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Subtasks</span>
              <span className="rounded-full bg-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {subtasks.length}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
              {kanbanCount} Hermes Kanban task{kanbanCount === 1 ? '' : 's'} synced on the right
            </p>
          </div>
          {subtasks.length > 3 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2 text-[11px] font-semibold text-zinc-600 shadow-sm transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-800"
              title="Show all subtasks"
            >
              <ListTree size={12} strokeWidth={2.5} />
              All
            </button>
          )}
          {live && (
            <span
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2 text-[11px] font-semibold text-emerald-700 shadow-sm dark:border-emerald-900/70 dark:bg-emerald-950/30 dark:text-emerald-300"
              title="Live via AgentControl SSE + Hermes Kanban reconciliation"
            >
              <Radio size={12} strokeWidth={2.5} className="animate-pulse" />
              Live
            </span>
          )}
        </div>
        <div className="mb-2 grid grid-cols-4 gap-1.5 text-center text-[10px]">
          <div className="rounded-lg border border-zinc-200 bg-white px-1.5 py-1 dark:border-zinc-800 dark:bg-zinc-900/80">
            <div className="font-semibold text-zinc-900 dark:text-zinc-100">{doneCount}/{subtasks.length}</div>
            <div className="text-zinc-500 dark:text-zinc-400">done</div>
          </div>
          <div className="rounded-lg border border-purple-200 bg-purple-50 px-1.5 py-1 dark:border-purple-900/70 dark:bg-purple-950/30">
            <div className="font-semibold text-purple-700 dark:text-purple-300">{reviewCount}</div>
            <div className="text-purple-700/70 dark:text-purple-300/70">review</div>
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-1.5 py-1 dark:border-amber-900/70 dark:bg-amber-950/30">
            <div className="font-semibold text-amber-700 dark:text-amber-300">{runningCount}</div>
            <div className="text-amber-700/70 dark:text-amber-300/70">running</div>
          </div>
          <div className="rounded-lg border border-red-200 bg-red-50 px-1.5 py-1 dark:border-red-900/70 dark:bg-red-950/30">
            <div className="font-semibold text-red-700 dark:text-red-300">{blockedCount}</div>
            <div className="text-red-700/70 dark:text-red-300/70">blocked</div>
          </div>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width] duration-300 ease-out dark:bg-emerald-400"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2.5">
        <div className="flex flex-col gap-2.5">
          {visibleSubtasks.map((subtask) => (
            <SubtaskRow key={subtask.id} subtask={subtask} />
          ))}
        </div>
      </div>
      {expanded && <SubtasksSlideover subtasks={visibleSubtasks} onClose={() => setExpanded(false)} />}
    </section>
  );
}

function SubtasksSlideover({ subtasks, onClose }: { subtasks: Task[]; onClose: () => void }) {
  const stats = subtasks.reduce(
    (acc, subtask) => {
      const effectiveStatus = getEffectiveDelegationStatus(subtask);
      if (effectiveStatus === 'done') acc.done += 1;
      if (effectiveStatus === 'running') acc.running += 1;
      if (effectiveStatus === 'blocked') acc.blocked += 1;
      if (effectiveStatus === 'review') acc.review += 1;
      return acc;
    },
    { done: 0, running: 0, blocked: 0, review: 0 },
  );
  const doneCount = stats.done;
  const runningCount = stats.running;
  const blockedCount = stats.blocked;
  const reviewCount = stats.review;
  const activeCount = runningCount + reviewCount + blockedCount;
  const visibleSubtasks = sortSubtasksForTriage(subtasks);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col lg:hidden">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative ml-auto flex h-full w-full max-w-sm flex-col border-l border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <GitBranch size={14} strokeWidth={2.5} className="text-zinc-500 dark:text-zinc-400" />
            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Subtasks</span>
            <span className="rounded-full bg-zinc-200 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {subtasks.length}
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          >
            <X size={16} strokeWidth={2.5} />
          </button>
        </div>
        <div className="shrink-0 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="font-medium">{activeCount}/{subtasks.length} active · {doneCount} done</span>
            <div className="flex items-center gap-2">
              {reviewCount > 0 && <span className="text-purple-600 dark:text-purple-400">{reviewCount} review</span>}
              {runningCount > 0 && <span className="text-amber-600 dark:text-amber-400">{runningCount} running</span>}
              {blockedCount > 0 && <span className="text-red-500 dark:text-red-400">{blockedCount} blocked</span>}
            </div>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-emerald-500 transition-[width] duration-300 ease-out dark:bg-emerald-400"
              style={{ width: `${subtasks.length > 0 ? Math.round((activeCount / subtasks.length) * 100) : 0}%` }}
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3">
          <div className="flex flex-col gap-2.5">
            {visibleSubtasks.map((subtask) => (
              <SubtaskRow key={subtask.id} subtask={subtask} />
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface ExecutionRailContentProps {
  task: Task;
  subtasks: Task[];
  kanbanInfo: KanbanTaskResponse | null;
  kanbanLogs: KanbanLogsResponse | null;
  githubStatus: GitHubStatusState;
  onGitHubRefresh: () => void;
  onGitHubEdit: () => void;
  prDraft: string;
  onPrDraftChange: (value: string) => void;
  onGitHubLink: (nextPrUrl?: string | null) => void;
  kanbanRefreshKey: number;
  className?: string;
}

function ExecutionRailContent({
  task,
  subtasks,
  kanbanInfo,
  kanbanLogs,
  githubStatus,
  onGitHubRefresh,
  onGitHubEdit,
  prDraft,
  onPrDraftChange,
  onGitHubLink,
  kanbanRefreshKey,
  className = '',
}: ExecutionRailContentProps) {
  const hasKanban = Boolean(kanbanInfo?.kanban_id ?? task.hermes_kanban_task_id);
  const hasSubtaskSidebar = !task.parent_task_id && subtasks.length > 0;
  const showWorkerTranscript = hasKanban && !hasSubtaskSidebar;

  return (
    <div className={`flex min-h-0 flex-col gap-2 ${className}`}>
      <KanbanPanel
        info={kanbanInfo}
        logs={kanbanLogs}
        github={githubStatus}
        onGitHubRefresh={onGitHubRefresh}
        onGitHubEdit={onGitHubEdit}
      />
      {showWorkerTranscript && (
        <TranscriptLog
          taskId={task.id}
          hasKanban={hasKanban}
          refreshKey={kanbanRefreshKey}
        />
      )}
      <GitHubPanel
        status={githubStatus}
        onRefresh={onGitHubRefresh}
        prDraft={prDraft}
        onPrDraftChange={onPrDraftChange}
        onLink={onGitHubLink}
        compact
      />
      {hasSubtaskSidebar && (
        <SubtasksSidebar
          subtasks={subtasks}
          live={Boolean(task.hermes_kanban_task_id)}
          className="flex-1"
        />
      )}
      {!kanbanInfo?.kanban_id && !githubStatus.prNumber && !githubStatus.prUrl && (task.parent_task_id || subtasks.length === 0) && (
        <div className="rounded-2xl border border-dashed border-zinc-200 bg-white/70 px-4 py-8 text-center text-xs text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-500">
          No Kanban metadata yet.
        </div>
      )}
    </div>
  );
}

function MobileExecutionRailSlideover({
  onClose,
  ...props
}: ExecutionRailContentProps & { onClose: () => void }) {
  const kanbanBacked = Boolean(props.kanbanInfo?.kanban_id ?? props.task.hermes_kanban_task_id);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col lg:hidden">
      <div className="absolute inset-0 bg-black/35 backdrop-blur-sm" onClick={onClose} />
      <div className="relative mt-auto flex h-[88dvh] w-full flex-col rounded-t-3xl border border-zinc-200 bg-zinc-50 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto mt-2 h-1.5 w-12 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        <div className="flex min-h-[64px] items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-900/70 dark:bg-purple-950/30 dark:text-purple-300">
                <Activity size={16} strokeWidth={2.5} />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">Execution rail</h2>
                <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                  Kanban, PR, worker transcript and subtasks
                </p>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close execution rail"
            className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <X size={18} strokeWidth={2.5} />
          </button>
        </div>
        <div className="flex items-center gap-2 overflow-x-auto border-b border-zinc-200 px-4 py-2 text-[11px] dark:border-zinc-800">
          <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 font-semibold ${kanbanBacked ? 'border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-900/70 dark:bg-purple-950/30 dark:text-purple-300' : 'border-zinc-200 bg-white text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400'}`}>
            <Activity size={11} strokeWidth={2.5} />
            {kanbanBacked ? 'Kanban live' : 'No Kanban'}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-zinc-200 bg-white px-2 py-1 font-medium text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
            <MessageSquareText size={11} strokeWidth={2.5} />
            Transcript
          </span>
          {props.subtasks.length > 0 && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-zinc-200 bg-white px-2 py-1 font-medium text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
              <GitBranch size={11} strokeWidth={2.5} />
              {props.subtasks.length} subtasks
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
          <ExecutionRailContent {...props} className="min-h-full" />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = location.state as { initialMessage?: string; initialSettings?: AgentRunSettings } | null;
  const initialMessage = locationState?.initialMessage;
  const initialSettings = locationState?.initialSettings;
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId) ?? null);
  const tasks = useStore((s) => s.tasks);
  const tasksLoaded = useStore((s) => s.tasksLoaded);
  const upsertTask = useStore((s) => s.upsertTask);
  const removeTask = useStore((s) => s.removeTask);
  const allSubtasks = useStore((s) => (taskId ? s.subtasksByParent.get(taskId) : undefined));
  const subtasks = useMemo(() => allSubtasks ?? [], [allSubtasks]);
  const setSubtasks = useStore((s) => s.setSubtasks);

  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const skipNextTitleSaveRef = useRef(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showSubtasksSlideover, setShowSubtasksSlideover] = useState(false);
  const [showMobileExecutionRail, setShowMobileExecutionRail] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const markViewedInFlightRef = useRef<string | null>(null);
  const [detailFetchInFlight, setDetailFetchInFlight] = useState(false);
  const [detailFetchFailed, setDetailFetchFailed] = useState(false);
  const [kanbanInfo, setKanbanInfo] = useState<KanbanTaskResponse | null>(null);
  const [kanbanLogs, setKanbanLogs] = useState<KanbanLogsResponse | null>(null);
  const [kanbanRefreshKey, setKanbanRefreshKey] = useState(0);
  const [githubStatus, setGitHubStatus] = useState<GitHubStatusState>({
    prUrl: null,
    prNumber: null,
    prState: null,
    headRef: null,
    headSha: null,
    checksStatus: null,
    checksSummary: null,
    checksUpdatedAt: null,
    refreshing: false,
    syncError: null,
    linking: false,
  });
  const [prDraft, setPrDraft] = useState('');
  const [githubEditorSignal, setGitHubEditorSignal] = useState(0);
  const titleAnimation = useRenameAnimation(task?.title ?? '', task?.id ?? null);

  useEffect(() => {
    if (!taskId || task || !tasksLoaded) {
      setDetailFetchInFlight(false);
      setDetailFetchFailed(false);
      return;
    }

    let cancelled = false;
    setDetailFetchInFlight(true);
    setDetailFetchFailed(false);

    fetchTask(taskId)
      .then(({ task: fetchedTask }) => {
        if (!cancelled) upsertTask(fetchedTask);
      })
      .catch(() => {
        if (!cancelled) setDetailFetchFailed(true);
      })
      .finally(() => {
        if (!cancelled) setDetailFetchInFlight(false);
      });

    return () => {
      cancelled = true;
    };
  }, [taskId, task, tasksLoaded, upsertTask]);

  useEffect(() => {
    if (!task?.parent_task_id) return;
    if (tasks.some((candidate) => candidate.id === task.parent_task_id)) return;

    let cancelled = false;
    fetchTask(task.parent_task_id)
      .then(({ task: parentTask }) => {
        if (!cancelled) upsertTask(parentTask);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [task?.parent_task_id, tasks, upsertTask]);

  useEffect(() => {
    if (task) setTitleDraft(task.title);
  }, [task?.id, task?.title]);

  useEffect(() => {
    if (!task || task.last_agent_response_at === null) return;
    if (task.last_viewed_at !== null && task.last_viewed_at >= task.last_agent_response_at) return;

    const key = `${task.id}:${task.last_agent_response_at}`;
    if (markViewedInFlightRef.current === key) return;
    markViewedInFlightRef.current = key;

    markTaskViewed(task.id)
      .then(({ task: updated }) => upsertTask(updated))
      .catch(() => {})
      .finally(() => {
        if (markViewedInFlightRef.current === key) {
          markViewedInFlightRef.current = null;
        }
      });
  }, [task?.id, task?.last_agent_response_at, task?.last_viewed_at, upsertTask]);

  useEffect(() => {
    if (initialMessage || initialSettings) {
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, [taskId, initialMessage, initialSettings, navigate, location.pathname]);

  const refreshSubtasks = useCallback(async (options?: { manual?: boolean }) => {
    if (!task || task.parent_task_id) return;
    try {
      const res = await (task.hermes_kanban_task_id
        ? syncTaskKanbanSubtasksFromChat(task.id)
        : fetchSubtasks(task.id));
      setSubtasks(task.id, res.subtasks);
      if (options?.manual) {
        toast('Kanban subtasks synced', {
          description: task.hermes_kanban_task_id
            ? `${res.subtasks.length} subtasks visible on the right`
            : `${res.subtasks.length} subtasks loaded`,
          icon: <RefreshCw size={14} strokeWidth={2.5} className="text-zinc-500 dark:text-zinc-400" />,
        });
      }
    } catch (err) {
      if (options?.manual) {
        toast.error('Kanban sync failed', {
          description: err instanceof Error ? err.message : 'Could not sync subtasks',
        });
      }
    }
  }, [task, setSubtasks]);

  useEffect(() => {
    if (!task || task.parent_task_id) return;
    let cancelled = false;
    const run = async () => {
      try {
        const res = await (task.hermes_kanban_task_id
          ? syncTaskKanbanSubtasksFromChat(task.id)
          : fetchSubtasks(task.id));
        if (!cancelled) setSubtasks(task.id, res.subtasks);
      } catch {
        // Best-effort: subtask sidebar should never block the task detail page.
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [task?.id, task?.parent_task_id, task?.hermes_kanban_task_id, setSubtasks]);

  useEffect(() => {
    if (!task?.hermes_kanban_task_id) {
      setKanbanInfo(null);
      setKanbanLogs(null);
      return;
    }

    let cancelled = false;
    function refreshKanban() {
      if (!task) return;
      Promise.all([
        fetchTaskKanban(task.id),
        fetchTaskKanbanLogs(task.id, 50),
      ])
        .then(([info, logs]) => {
          if (!cancelled) {
            setKanbanInfo(info);
            setKanbanLogs(logs);
            setKanbanRefreshKey((key) => key + 1);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setKanbanInfo(null);
            setKanbanLogs(null);
          }
        });
    }

    refreshKanban();
    const timer = window.setInterval(refreshKanban, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [task?.id, task?.hermes_kanban_task_id]);

  // GitHub status: seed from task fields on load, allow manual refresh
  useEffect(() => {
    if (!task) return;
    setGitHubStatus((prev) => ({
      ...prev,
      prUrl: task.github_pr_url ?? prev.prUrl,
      prNumber: task.github_pr_number ?? prev.prNumber,
      prState: task.github_pr_state ?? prev.prState,
      headRef: task.github_pr_head_ref ?? prev.headRef,
      headSha: task.github_pr_head_sha ?? prev.headSha,
      checksStatus: task.github_checks_status ?? prev.checksStatus,
      checksSummary: task.github_checks_summary ?? prev.checksSummary,
      checksUpdatedAt: task.github_checks_updated_at ?? prev.checksUpdatedAt,
      linking: false,
    }));
    setPrDraft(task.github_pr_url ?? '');
  }, [task?.github_pr_url, task?.github_pr_number, task?.github_pr_state, task?.github_pr_head_ref, task?.github_pr_head_sha, task?.github_checks_status, task?.github_checks_summary, task?.github_checks_updated_at]);

  const handleRefreshGitHub = useCallback(async () => {
    if (!taskId) return;
    setGitHubStatus((prev) => ({ ...prev, refreshing: true, syncError: null }));
    try {
      const data = await refreshTaskGitHubStatus(taskId);
      setGitHubStatus({
        prUrl: data.github_pr_url ?? null,
        prNumber: data.github_pr_number ?? null,
        prState: data.github_pr_state ?? null,
        headRef: data.github_pr_head_ref ?? null,
        headSha: data.github_pr_head_sha ?? null,
        checksStatus: data.github_checks_status ?? null,
        checksSummary: data.github_checks_summary ?? null,
        checksUpdatedAt: data.github_checks_updated_at ?? null,
        refreshing: false,
        linking: false,
        syncError: data.error ?? null,
      });
      setPrDraft(data.github_pr_url ?? '');
      if (data.github_pr_url || data.github_checks_status) {
        toast('GitHub status synced', {
          icon: <GitPullRequest size={14} strokeWidth={2.5} className="text-zinc-500 dark:text-zinc-400" />,
        });
      }
    } catch (err) {
      setGitHubStatus((prev) => ({
        ...prev,
        refreshing: false,
        linking: false,
        syncError: err instanceof Error ? err.message : 'Sync failed',
      }));
    }
  }, [taskId]);

  const handleLinkGitHubPr = useCallback(async (nextPrUrl?: string | null) => {
    if (!taskId) return;
    const trimmed = (nextPrUrl ?? prDraft).trim();
    setGitHubStatus((prev) => ({ ...prev, linking: true, syncError: null }));
    try {
      const data = await linkTaskGitHubPr(taskId, trimmed || null);
      setGitHubStatus({
        prUrl: data.github_pr_url ?? null,
        prNumber: data.github_pr_number ?? null,
        prState: data.github_pr_state ?? null,
        headRef: data.github_pr_head_ref ?? null,
        headSha: data.github_pr_head_sha ?? null,
        checksStatus: data.github_checks_status ?? null,
        checksSummary: data.github_checks_summary ?? null,
        checksUpdatedAt: data.github_checks_updated_at ?? null,
        refreshing: false,
        linking: false,
        syncError: null,
      });
      setPrDraft(data.github_pr_url ?? '');
      toast(trimmed ? 'GitHub PR linked' : 'GitHub PR cleared', {
        description: data.note,
        icon: <GitPullRequest size={14} strokeWidth={2.5} className="text-zinc-500 dark:text-zinc-400" />,
      });
    } catch (err) {
      setGitHubStatus((prev) => ({
        ...prev,
        linking: false,
        syncError: err instanceof Error ? err.message : 'Could not link PR',
      }));
      toast.error('GitHub PR not linked', {
        description: err instanceof Error ? err.message : 'Could not link PR',
      });
    }
  }, [taskId, prDraft]);

  useEffect(() => {
    if (!showMenu) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showMenu]);

  const handleTitleSave = useCallback(async () => {
    if (!task) return;
    if (skipNextTitleSaveRef.current) {
      skipNextTitleSaveRef.current = false;
      setTitleDraft(task.title);
      return;
    }

    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== task.title) {
      try {
        const { task: updated } = await patchTask(task.id, { title: trimmed });
        upsertTask(updated);
      } catch {
        setTitleDraft(task.title);
      }
    } else {
      setTitleDraft(task.title);
    }
  }, [task, titleDraft, upsertTask]);

  const handleStatusChange = useCallback(async (status: TaskStatus) => {
    if (!task) return;
    setShowMenu(false);
    if (status === 'done') {
      const previousStatus = task.status;
      const taskId = task.id;
      try {
        await optimisticMoveTask(task, 'done', upsertTask, moveTask);
      } catch (error) {
        toast.error('Task not completed', {
          description: error instanceof ApiError ? error.message : 'Linked PR could not be merged.',
        });
        return;
      }
      navigate('/');
      toast('Task completed', {
        icon: <Check size={14} strokeWidth={2.5} className="text-zinc-500 dark:text-zinc-400" />,
        action: {
          label: 'Undo',
          onClick: () => {
            const { tasks, upsertTask: storeUpsert } = useStore.getState();
            const current = tasks.find((t) => t.id === taskId);
            if (current) optimisticMoveTask(current, previousStatus, storeUpsert, moveTask);
          },
        },
      });
    } else {
      try {
        await optimisticMoveTask(task, status, upsertTask, moveTask);
      } catch (error) {
        toast.error('Task not moved', {
          description: error instanceof ApiError ? error.message : 'Linked PR could not be merged.',
        });
      }
    }
  }, [task, upsertTask, navigate]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isEditableTarget(e.target)) navigate('/');
      if (e.key === 'd' && e.metaKey && e.shiftKey && task && task.status !== 'done') {
        e.preventDefault();
        handleStatusChange('done');
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [navigate, task, handleStatusChange]);

  const handleDelete = useCallback(async () => {
    if (!task) return;
    try {
      await deleteTask(task.id);
      removeTask(task.id);
      navigate('/');
    } catch {}
  }, [task, removeTask, navigate]);

  if (!task) {
    if (!tasksLoaded || detailFetchInFlight) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={24} className="animate-spin text-zinc-400" />
        </div>
      );
    }
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-zinc-400 dark:text-zinc-500">
          {detailFetchFailed ? 'Task not found' : 'Loading task...'}
        </p>
      </div>
    );
  }

  const statusMeta = STATUS_META[task.status];
  const parentTask = task.parent_task_id
    ? tasks.find((candidate) => candidate.id === task.parent_task_id) ?? null
    : null;
  const executionRailAvailable = Boolean(
    kanbanInfo?.kanban_id
    || task.hermes_kanban_task_id
    || githubStatus.prNumber
    || githubStatus.prUrl
    || subtasks.length > 0,
  );
  const showDesktopExecutionRail = executionRailAvailable;
  const contentGridClassName = showDesktopExecutionRail
    ? 'grid w-full flex-1 min-h-0 grid-cols-1 border-t border-zinc-200 dark:border-zinc-800 lg:grid-cols-[minmax(0,1fr)_minmax(720px,760px)] 2xl:grid-cols-[minmax(0,1fr)_minmax(760px,820px)]'
    : 'grid w-full flex-1 min-h-0 grid-cols-1 border-t border-zinc-200 dark:border-zinc-800';
  const executionRailProps: ExecutionRailContentProps = {
    task,
    subtasks,
    kanbanInfo,
    kanbanLogs,
    githubStatus,
    onGitHubRefresh: handleRefreshGitHub,
    onGitHubEdit: () => setGitHubEditorSignal((value) => value + 1),
    prDraft,
    onPrDraftChange: setPrDraft,
    onGitHubLink: handleLinkGitHubPr,
    kanbanRefreshKey,
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="w-full px-3 py-1.5 sm:px-6 sm:py-2">
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="-ml-2 relative w-full rounded-md px-2 py-0.5 pr-10 transition-colors hover:bg-zinc-100/80 focus-within:bg-white focus-within:ring-1 focus-within:ring-zinc-200 dark:hover:bg-zinc-800/80 dark:focus-within:bg-zinc-900 dark:focus-within:ring-zinc-700">
              <div className="rename-title-shell">
                <input
                  ref={titleInputRef}
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={handleTitleSave}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      titleInputRef.current?.blur();
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      skipNextTitleSaveRef.current = true;
                      setTitleDraft(task.title);
                      titleInputRef.current?.blur();
                    }
                  }}
                  aria-label="Task title"
                  placeholder="Name this task"
                  className={`block w-full cursor-text truncate bg-transparent p-0 text-base font-semibold leading-6 text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500 sm:text-lg sm:leading-7 ${
                    titleAnimation.isAnimating ? 'rename-title-input-hidden' : ''
                  }`}
                />
                <RenameReveal
                  animation={titleAnimation}
                  className="text-base font-semibold leading-6 text-zinc-900 dark:text-zinc-100 sm:text-lg sm:leading-7"
                />
              </div>
              <button
                type="button"
                title="Rename task"
                aria-label="Rename task"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  titleInputRef.current?.focus();
                  titleInputRef.current?.select();
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
              >
                <Pencil size={15} />
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2.5 sm:shrink-0 sm:justify-start">
            <div className="flex items-center gap-2.5">
              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${statusMeta.tint}`}>
                <StatusIcon status={task.status} />
                {statusMeta.label}
              </span>

              <span className="text-xs text-zinc-400 dark:text-zinc-500 shrink-0">
                {timeAgo(task.updated_at)}
              </span>
              {task.parent_task_id && (
                <span className="inline-flex max-w-[260px] items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                  <GitBranch size={12} strokeWidth={2.5} className="shrink-0" />
                  <span className="shrink-0">Subtask of</span>
                  {parentTask ? (
                    <button
                      type="button"
                      onClick={() => navigate(`/tasks/${parentTask.id}`)}
                      className="min-w-0 truncate font-medium text-zinc-800 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-950 dark:text-zinc-100 dark:decoration-zinc-600 dark:hover:text-white"
                      title={parentTask.title}
                    >
                      {parentTask.title}
                    </button>
                  ) : (
                    <span className="min-w-0 truncate font-mono text-[11px]">{task.parent_task_id}</span>
                  )}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5 sm:gap-2.5">
              {executionRailAvailable && (
                <button
                  type="button"
                  onClick={() => setShowMobileExecutionRail(true)}
                  aria-label="Open execution rail"
                  className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border border-purple-200 bg-purple-50 px-3 text-xs font-semibold text-purple-700 transition-colors hover:border-purple-300 hover:bg-purple-100 dark:border-purple-900/70 dark:bg-purple-950/40 dark:text-purple-300 dark:hover:bg-purple-950/70 lg:hidden"
                >
                  <Activity size={14} strokeWidth={2.5} />
                  Rail
                </button>
              )}
              {task.status !== 'done' && (
                <div className="group relative shrink-0">
                  <button
                    onClick={() => handleStatusChange('done')}
                    aria-label="Mark complete"
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-zinc-900 p-1.5 text-zinc-100 transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 sm:px-3 sm:py-1.5 sm:text-xs sm:font-semibold"
                  >
                    <Check size={14} strokeWidth={2.5} />
                    <span className="hidden sm:inline">Mark complete</span>
                  </button>
                  <div className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-[11px] text-zinc-500 opacity-0 shadow-lg transition-opacity group-hover:opacity-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 max-sm:hidden">
                    <div className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-l border-t border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900" />
                    <span className="flex items-center gap-1">
                      {['⌘', '⇧', 'D'].map((k) => (
                        <kbd key={k} className="inline-flex h-4 min-w-[16px] items-center justify-center rounded border border-zinc-200 bg-zinc-100 px-1 font-sans text-[10px] text-zinc-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{k}</kbd>
                      ))}
                    </span>
                  </div>
                </div>
              )}

              <div className="relative shrink-0">
                <button
                  onClick={() => setShowMenu(!showMenu)}
                  className="p-1.5 rounded-md text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                >
                  <MoreHorizontal size={16} />
                </button>
                {showMenu && (
                  <div ref={menuRef} className="absolute right-0 top-full mt-1 min-w-[180px] py-1 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 shadow-xl z-50">
                    <p className="px-3 py-1.5 text-[11px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">
                      Move to
                    </p>
                    {TASK_STATUSES.filter((s) => s !== task.status).map((status) => (
                      <button
                        key={status}
                        onClick={() => handleStatusChange(status)}
                        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-left"
                      >
                        <StatusIcon status={status} />
                        {STATUS_META[status].label}
                      </button>
                    ))}
                    <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
                    {!task.parent_task_id && subtasks.length > 0 && (
                      <>
                        <p className="px-3 py-1.5 text-[11px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider lg:hidden">
                          Subtasks
                        </p>
                        <button
                          onClick={() => { setShowMenu(false); setShowSubtasksSlideover(true); }}
                          className="lg:hidden w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-left"
                        >
                          <GitBranch size={14} strokeWidth={2} />
                          Subtasks ({subtasks.length})
                        </button>
                        <div className="lg:hidden my-1 border-t border-zinc-200 dark:border-zinc-800" />
                      </>
                    )}
                    <button
                      onClick={() => { setShowMenu(false); setShowDeleteConfirm(true); }}
                      className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-left"
                    >
                      <Trash2 size={14} />
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={contentGridClassName}>
        <section className="flex min-h-0 min-w-0 flex-col bg-white dark:bg-zinc-950">
          <TaskChat taskId={task.id} initialMessage={initialMessage} initialSettings={initialSettings} />
        </section>

        {showDesktopExecutionRail && (
          <aside className="hidden min-h-0 overflow-hidden border-l border-zinc-200 bg-gradient-to-b from-zinc-50 to-white p-4 dark:border-zinc-800 dark:from-zinc-950 dark:to-zinc-950/80 lg:block">
            <ExecutionRailContent {...executionRailProps} className="h-full" />
          </aside>
        )}
      </div>

      {showSubtasksSlideover && subtasks.length > 0 && (
        <SubtasksSlideover
          subtasks={subtasks}
          onClose={() => setShowSubtasksSlideover(false)}
        />
      )}

      {showMobileExecutionRail && executionRailAvailable && (
        <MobileExecutionRailSlideover
          {...executionRailProps}
          onClose={() => setShowMobileExecutionRail(false)}
        />
      )}

      <GitHubPanel
        status={githubStatus}
        onRefresh={handleRefreshGitHub}
        prDraft={prDraft}
        onPrDraftChange={setPrDraft}
        onLink={handleLinkGitHubPr}
        compact
        openEditorSignal={githubEditorSignal}
      />

      {showDeleteConfirm && (
        <DeleteConfirmModal
          onConfirm={() => { setShowDeleteConfirm(false); handleDelete(); }}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
