import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Columns3, Layers, ExternalLink, AlertTriangle,
  Loader2, CheckCircle2, Clock, MessageSquare, Send,
  FileText, RefreshCw,
} from 'lucide-react';
import { LazyLog, ScrollFollow } from '@melloware/react-logviewer';
import {
  fetchKanbanBoards, fetchBoardTasks,
  fetchBoardTaskBlockers, fetchBoardTaskLogs,
  deleteKanbanBoard, postKanbanComment, claimKanbanTask,
  type KanbanBoardSummary,
} from '../lib/api';
import type { KanbanTaskInfo, KanbanCommentEntry, BoardEvent } from '@shared/types';

// ── Constants ──────────────────────────────────────────────────────────

// Cascade smoke: grandchild t_458ad394 verified — 3-level chain works
const apiOrigin = window.location.origin;

// ── Helpers ────────────────────────────────────────────────────────────

function date(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function statusColor(status: string): string {
  switch (status) {
    case 'running': return 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40';
    case 'done': return 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40';
    case 'review': return 'text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40';
    case 'blocked': return 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40';
    case 'ready': return 'text-sky-600 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/40';
    case 'archived': return 'text-zinc-400 dark:text-zinc-500 bg-zinc-100 dark:bg-zinc-800';
    default: return 'text-zinc-500 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900/50';
  }
}

// Priority: blocked = 0, running = 1, review = 2, ready = 3, other = 4, done = 5, archived = 6
function taskPriority(status: string): number {
  switch (status) {
    case 'blocked': return 0;
    case 'running': return 1;
    case 'review': return 2;
    case 'ready': return 3;
    case 'done': return 5;
    case 'archived': return 6;
    default: return 4;
  }
}

function isInactive(status: string): boolean {
  return status === 'done' || status === 'archived';
}

function boardPriority(board: KanbanBoardSummary): number {
  // Active boards (with running/blocked tasks) first, then boards with only done, then empty
  const active = board.activeTaskCount || 0;
  const total = board.taskCount || 0;
  const done = board.doneTaskCount || 0;
  if (active > 0) return 0;
  if (total > done) return 1; // has non-done tasks
  if (done > 0) return 2; // all done
  return 3; // empty
}

// ── Panel wrapper ──────────────────────────────────────────────────────

function Panel({ title, icon, className = '', children }: { title: string; icon: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <div className={`flex flex-col min-h-0 border-r border-zinc-200 dark:border-zinc-800 last:border-r-0 ${className}`}>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        {icon}
        <span className="font-semibold text-sm text-zinc-700 dark:text-zinc-200 uppercase tracking-wide">{title}</span>
      </div>
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}

// ── Board Card ─────────────────────────────────────────────────────────

function BoardCard({ board, active, onClick, onDelete }: {
  board: KanbanBoardSummary; active: boolean; onClick: () => void; onDelete: () => void;
}) {
  const allDone = board.taskCount > 0 && board.doneTaskCount >= board.taskCount;
  const activeCount = board.activeTaskCount || 0;

  return (
    <div className="group relative">
      <button
        onClick={onClick}
        className={`w-full text-left p-3 pr-8 rounded-lg transition-colors ${
          active
            ? 'bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800'
            : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
        } ${allDone ? 'opacity-60 hover:opacity-80' : ''}`}
      >
        <div className={`font-medium text-sm ${allDone ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-800 dark:text-zinc-100'}`}>
          {board.name}
        </div>
        <div className="flex items-center gap-3 mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
          <span>{board.taskCount} tasks</span>
          {activeCount > 0 && (
            <span className="text-amber-600 dark:text-amber-400 font-semibold">{activeCount} active</span>
          )}
          {allDone && (
            <span className="text-emerald-600 dark:text-emerald-400">{board.doneTaskCount} done</span>
          )}
        </div>
      </button>
      {/* Delete button — only for non-default boards */}
      {board.name !== 'default' && (
        <button
          onClick={(e) => { e.stopPropagation(); if (confirm(`Delete board "${board.name}"? This cannot be undone.`)) onDelete(); }}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-100 dark:hover:bg-red-950/40 text-zinc-400 hover:text-red-500 dark:hover:text-red-400 transition-all text-[10px]"
          title="Delete board"
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ── Task Card ──────────────────────────────────────────────────────────

function TaskCard({ task, active, onClick }: {
  task: KanbanTaskInfo; active: boolean; onClick: () => void;
}) {
  const inactive = isInactive(task.status);

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 rounded-lg transition-colors ${
        active
          ? 'bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800'
          : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
      } ${inactive ? 'opacity-50 hover:opacity-70' : ''}`}
    >
      <div className="flex items-start gap-2">
        <span className={`shrink-0 inline-block px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide ${statusColor(task.status)}`}>
          {task.status}
        </span>
        <span className={`text-sm line-clamp-2 font-medium ${inactive ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-800 dark:text-zinc-100'}`}>
          {task.title}
        </span>
      </div>
      {task.assignee && (
        <div className={`mt-1.5 text-xs ${inactive ? 'text-zinc-400/70 dark:text-zinc-500/70' : 'text-zinc-400 dark:text-zinc-500'}`}>
          {task.assignee}
        </div>
      )}
    </button>
  );
}

// ── Worker Transcript for Kanban ───────────────────────────────────────

function KanbanTranscript({ board, taskId }: { board: string; taskId: string }) {
  const url = `${apiOrigin}/api/kanban/boards/${encodeURIComponent(board)}/tasks/${encodeURIComponent(taskId)}/transcript?format=raw`;

  return (
    <div className="rounded-2xl border border-amber-100 bg-white/90 shadow-sm shadow-amber-100/30 dark:border-amber-900/40 dark:bg-zinc-900/80 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-amber-100 px-3 py-1.5 dark:border-amber-900/40">
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-300">
          <FileText size={11} strokeWidth={2.5} />
          Worker Transcript
        </span>
        <span className="text-[9px] text-zinc-400 dark:text-zinc-500">live</span>
      </div>
      <div style={{ height: 420 }}>
        <ScrollFollow
          startFollowing={true}
          render={({ follow, onScroll }) => (
            <LazyLog
              url={url}
              stream
              follow={follow}
              onScroll={onScroll}
              fetchOptions={{ credentials: 'same-origin' }}
              style={{ backgroundColor: 'transparent', color: 'inherit', fontSize: 11 }}
              extraLines={1}
              enableSearch
              selectableLines
            />
          )}
        />
      </div>
    </div>
  );
}

// ── Comments Panel ─────────────────────────────────────────────────────

function CommentsPanel({
  board, taskId, comments, onCommentAdded,
}: {
  board: string; taskId: string;
  comments: KanbanCommentEntry[];
  onCommentAdded: (comments: KanbanCommentEntry[]) => void;
}) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = useCallback(async () => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    setError('');
    try {
      const data = await postKanbanComment(board, taskId, text);
      onCommentAdded(data.comments);
      setBody('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to send comment');
    } finally {
      setSending(false);
    }
  }, [body, sending, board, taskId, onCommentAdded]);

  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-2 flex items-center gap-1.5">
        <MessageSquare size={12} />
        Comments
      </h3>

      {/* Existing comments */}
      {comments.length > 0 ? (
        <div className="space-y-2 mb-3 max-h-48 overflow-y-auto">
          {comments.map((c) => (
            <div key={c.comment_id} className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/50 px-2.5 py-1.5">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-[10px] font-semibold text-zinc-600 dark:text-zinc-300">{c.author}</span>
                <span className="text-[9px] text-zinc-400">{date(c.created_at)}</span>
              </div>
              <p className="text-xs text-zinc-700 dark:text-zinc-200 whitespace-pre-wrap">{c.body}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-zinc-400 italic mb-3">No comments yet</div>
      )}

      {/* Input */}
      <div className="flex gap-1.5">
        <input
          type="text"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
          placeholder="Add a comment to unblock or steer..."
          className="flex-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
        />
        <button
          onClick={handleSubmit}
          disabled={sending || !body.trim()}
          className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </div>
      {error && <p className="mt-1 text-[10px] text-red-500">{error}</p>}
    </div>
  );
}

// ── Board detail (right panel) ─────────────────────────────────────────

function BoardDetail({ board, tasks }: { board: KanbanBoardSummary; tasks: KanbanTaskInfo[] }) {
  const kanbanPath = board.name === 'default'
    ? '~/.hermes/kanban.db'
    : `~/.hermes/kanban/boards/${board.name}/kanban.db`;
  const counts = { total: tasks.length, done: 0, running: 0, blocked: 0, ready: 0, review: 0, other: 0 };
  for (const t of tasks) {
    if (t.status === 'done') counts.done++;
    else if (t.status === 'running') counts.running++;
    else if (t.status === 'blocked') counts.blocked++;
    else if (t.status === 'ready') counts.ready++;
    else if (t.status === 'review') counts.review++;
    else counts.other++;
  }

  return (
    <div className="p-4 space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-1">Board</h3>
        <span className="inline-flex items-center gap-1.5 text-sm font-mono text-zinc-600 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-900 rounded px-2 py-1">
          <ExternalLink size={12} className="text-zinc-400" />
          {kanbanPath}
        </span>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-2">Status</h3>
        <div className="grid grid-cols-2 gap-2">
          <CountBadge label="Total" count={counts.total} color="text-zinc-600 dark:text-zinc-300" />
          <CountBadge label="Blocked" count={counts.blocked} color="text-red-600 dark:text-red-400" />
          <CountBadge label="Running" count={counts.running} color="text-amber-600 dark:text-amber-400" />
          <CountBadge label="Review" count={counts.review} color="text-indigo-600 dark:text-indigo-400" />
          <CountBadge label="Ready" count={counts.ready} color="text-sky-600 dark:text-sky-400" />
          <CountBadge label="Done" count={counts.done} color="text-emerald-600 dark:text-emerald-400" />
        </div>
      </div>
    </div>
  );
}

function CountBadge({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className="flex items-center justify-between px-2 py-1 rounded bg-zinc-50 dark:bg-zinc-900/50">
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className={`text-sm font-bold ${count > 0 ? color : 'text-zinc-300 dark:text-zinc-600'}`}>{count}</span>
    </div>
  );
}

// ── Task detail (right panel, when task selected) ──────────────────────

function TaskDetail({
  boardName, task, onBack, onTaskUpdated,
}: {
  boardName: string; task: KanbanTaskInfo; onBack: () => void;
  onTaskUpdated: (task: KanbanTaskInfo, tasks: KanbanTaskInfo[]) => void;
}) {
  const [blockers, setBlockers] = useState<{ kanban_id: string; title: string; status: string }[]>([]);
  const [blockersLoading, setBlockersLoading] = useState(false);
  const [comments, setComments] = useState<KanbanCommentEntry[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [claiming, setClaiming] = useState(false);

  const canClaim = task.status === 'ready' || task.status === 'todo' || task.status === 'pending';

  const handleClaim = async () => {
    setClaiming(true);
    try {
      const res = await claimKanbanTask(boardName, task.kanban_id);
      onTaskUpdated(res.task, res.tasks);
    } catch (e) {
      console.error('Claim failed', e);
    } finally {
      setClaiming(false);
    }
  };

  // Load blockers + comments
  useEffect(() => {
    let cancelled = false;

    if (task.status === 'blocked') {
      setBlockersLoading(true);
      fetchBoardTaskBlockers(boardName, task.kanban_id)
        .then((res) => { if (!cancelled) setBlockers(res.blockers); })
        .catch(() => {})
        .finally(() => { if (!cancelled) setBlockersLoading(false); });
    }
    setCommentsLoading(true);
    fetchBoardTaskLogs(boardName, task.kanban_id, 50)
      .then((res) => { if (!cancelled) setComments(res.comments); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setCommentsLoading(false); });

    return () => { cancelled = true; };
  }, [boardName, task.kanban_id, task.status]);

  const kanbanPath = boardName === 'default'
    ? '~/.hermes/kanban.db'
    : `~/.hermes/kanban/boards/${boardName}/kanban.db`;

  return (
    <div className="p-4 space-y-4">
      {/* Back */}
      <button
        onClick={onBack}
        className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
      >
        ← Board overview
      </button>

      {/* Title + status */}
      <div>
        <h2 className="text-sm font-bold text-zinc-800 dark:text-zinc-100">{task.title}</h2>
        <div className="flex items-center gap-2 mt-1">
          <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase ${statusColor(task.status)}`}>
            {task.status}
          </span>
          {task.assignee && (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{task.assignee}</span>
          )}
          {task.created_at && (
            <span className="text-xs text-zinc-400 dark:text-zinc-500 flex items-center gap-1">
              <Clock size={10} /> {date(task.created_at)}
            </span>
          )}
        </div>
      </div>

      {/* Claim button for ready/todo tasks */}
      {canClaim && (
        <button
          onClick={handleClaim}
          disabled={claiming}
          className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold py-2 px-3 transition-colors flex items-center justify-center gap-1.5"
        >
          {claiming ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
          )}
          Claim &amp; Start
        </button>
      )}

      {/* Board link */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-1">Kanban Board</h3>
        <span className="inline-flex items-center gap-1.5 text-sm font-mono text-zinc-600 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-900 rounded px-2 py-1">
          <ExternalLink size={12} className="text-zinc-400" />
          {kanbanPath}
        </span>
      </div>

      {/* Blockers (only for blocked tasks) */}
      {task.status === 'blocked' && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-2 flex items-center gap-1.5">
            <AlertTriangle size={12} className="text-red-500" />
            Blocked by
          </h3>
          {blockersLoading ? (
            <Loader2 size={14} className="animate-spin text-zinc-400" />
          ) : blockers.length === 0 ? (
            <p className="text-xs text-zinc-400 italic">No blockers found</p>
          ) : (
            <div className="space-y-1.5">
              {blockers.map((b) => (
                <div
                  key={b.kanban_id}
                  className="flex items-center justify-between px-2 py-1.5 rounded bg-red-50 dark:bg-red-950/30 border border-red-100 dark:border-red-900/50"
                >
                  <span className="text-xs text-zinc-700 dark:text-zinc-300 truncate mr-2">{b.title}</span>
                  <span className={`shrink-0 px-1 py-0.5 rounded text-[9px] font-semibold uppercase ${statusColor(b.status)}`}>
                    {b.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Done info */}
      {task.status === 'done' && task.completed_at && (
        <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 size={12} />
          Completed {date(task.completed_at)}
        </div>
      )}

      {/* Comments */}
      {commentsLoading ? (
        <Loader2 size={14} className="animate-spin text-zinc-400" />
      ) : (
        <CommentsPanel
          board={boardName}
          taskId={task.kanban_id}
          comments={comments}
          onCommentAdded={setComments}
        />
      )}

      {/* Worker Transcript */}
      <KanbanTranscript board={boardName} taskId={task.kanban_id} />
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────

export function KanbanPage() {
  const [boards, setBoards] = useState<KanbanBoardSummary[]>([]);
  const [tasks, setTasks] = useState<KanbanTaskInfo[]>([]);
  const [selectedBoard, setSelectedBoard] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<number>(0); // for tracking SSE freshness

  // ── SSE + BroadcastChannel for realtime Kanban sync ─────────────────

  const refreshBoards = useCallback(() => {
    fetchKanbanBoards()
      .then((res) => {
        const sorted = [...res.boards].sort((a, b) => boardPriority(a) - boardPriority(b));
        setBoards(sorted);
      })
      .catch(console.error);
  }, []);

  const refreshTasks = useCallback((board: string) => {
    fetchBoardTasks(board)
      .then((res) => {
        const sorted = [...res.tasks].sort((a, b) => taskPriority(a.status) - taskPriority(b.status));
        setTasks(sorted);
      })
      .catch(console.error);
  }, []);

  // SSE for realtime updates
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      es = new EventSource('/api/events');

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as BoardEvent;
          if (event.type === 'kanban_changed') {
            const { board: eventBoard } = event;
            // If we're viewing this board, refresh tasks. Otherwise refresh boards.
            if (selectedBoard === eventBoard) {
              refreshTasks(eventBoard);
            } else {
              refreshBoards();
            }
            setLastRefresh(Date.now());
          }
        } catch {}
      };

      es.onerror = () => {
        es?.close();
        reconnectTimer = setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      es?.close();
      clearTimeout(reconnectTimer);
    };
  }, [selectedBoard, refreshBoards, refreshTasks]);

  // BroadcastChannel: receive events from OTHER tabs
  useEffect(() => {
    const bc = new BroadcastChannel('agentcontrol');

    bc.onmessage = (e) => {
      const event = e.data as BoardEvent;
      if (event?.type === 'kanban_changed') {
        if (selectedBoard === event.board) {
          refreshTasks(event.board);
        } else {
          refreshBoards();
        }
        setLastRefresh(Date.now());
      }
    };

    return () => bc.close();
  }, [selectedBoard, refreshBoards, refreshTasks]);

  // ── Auto-refresh active task detail (keep status + blockers/comments fresh) ──

  useEffect(() => {
    if (!selectedBoard || !selectedTask) return;
    const interval = setInterval(() => {
      fetchBoardTasks(selectedBoard)
        .then((res) => {
          const sorted = [...res.tasks].sort((a, b) => taskPriority(a.status) - taskPriority(b.status));
          setTasks(sorted);
          setLastRefresh(Date.now());
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
  }, [selectedBoard, selectedTask]);

  // Initial board fetch
  useEffect(() => { refreshBoards(); }, [refreshBoards]);

  const selectBoard = useCallback((name: string) => {
    setSelectedBoard(name);
    setSelectedTask(null);
    setTasks([]);
    setLoading(true);
    fetchBoardTasks(name)
      .then((res) => {
        const sorted = [...res.tasks].sort((a, b) => taskPriority(a.status) - taskPriority(b.status));
        setTasks(sorted);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleDeleteBoard = useCallback(async (name: string) => {
    try {
      const res = await deleteKanbanBoard(name);
      const sorted = [...res.boards].sort((a, b) => boardPriority(a) - boardPriority(b));
      setBoards(sorted);
      if (selectedBoard === name) {
        setSelectedBoard(null);
        setTasks([]);
      }
    } catch (e) {
      console.error('Delete failed', e);
      alert('Delete failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
    }
  }, [selectedBoard]);

  const selectedBoardSummary = boards.find((b) => b.name === selectedBoard);
  const selectedTaskInfo = tasks.find((t) => t.kanban_id === selectedTask);

  const handleTaskUpdated = useCallback((updatedTask: KanbanTaskInfo, updatedTasks: KanbanTaskInfo[]) => {
    setTasks(updatedTasks);
  }, []);

  let rightPanelContent: React.ReactNode;
  if (selectedTaskInfo && selectedBoard) {
    rightPanelContent = (
      <TaskDetail
        boardName={selectedBoard}
        task={selectedTaskInfo}
        onBack={() => setSelectedTask(null)}
        onTaskUpdated={handleTaskUpdated}
      />
    );
  } else if (selectedBoardSummary) {
    rightPanelContent = <BoardDetail board={selectedBoardSummary} tasks={tasks} />;
  } else {
    rightPanelContent = (
      <div className="flex items-center justify-center py-16 text-sm text-zinc-400 dark:text-zinc-500">
        Select a board to view details
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 overflow-x-auto">
      {/* BOARD LIST */}
      <Panel title="Boards" icon={<Columns3 size={16} className="text-indigo-500" />} className="w-56">
        <div className="p-2 space-y-1">
          {boards.map((b) => (
            <BoardCard key={b.name} board={b} active={selectedBoard === b.name} onClick={() => selectBoard(b.name)} onDelete={() => handleDeleteBoard(b.name)} />
          ))}
        </div>
      </Panel>

      {/* TASK LIST */}
      <Panel title="Tasks" icon={<Layers size={16} className="text-indigo-500" />} className="w-64">
        {loading && !tasks.length ? (
          <div className="flex items-center justify-center py-12"><Loader2 size={20} className="animate-spin text-zinc-400" /></div>
        ) : (
          <div className="p-2 space-y-1">
            {tasks.map((t) => (
              <TaskCard
                key={t.kanban_id}
                task={t}
                active={selectedTask === t.kanban_id}
                onClick={() => setSelectedTask(t.kanban_id)}
              />
            ))}
          </div>
        )}
      </Panel>

      {/* DETAIL */}
      <Panel title="Detail" icon={<span className="text-indigo-500 text-sm font-bold">i</span>} className="flex-1">
        {rightPanelContent}
      </Panel>
    </div>
  );
}
