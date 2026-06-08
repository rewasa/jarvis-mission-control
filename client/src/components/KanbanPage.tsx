import { useEffect, useRef, useState } from 'react';
import {
  Columns3, Layers, ExternalLink, AlertTriangle,
  Loader2, CheckCircle2, Clock,
} from 'lucide-react';
import {
  fetchKanbanBoards, fetchBoardTasks,
  fetchBoardTaskBlockers,
  type KanbanBoardSummary,
} from '../lib/api';
import { useStore } from '../lib/store';
import type { KanbanTaskInfo } from '@shared/types';

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

// ── Panel wrapper ──────────────────────────────────────────────────────

function Panel({ title, icon, panelId, className = '', children }: { title: string; icon: React.ReactNode; panelId?: string; className?: string; children: React.ReactNode }) {
  return (
    <div data-panel={panelId} className={`flex flex-col min-h-0 snap-start shrink-0 border-r border-zinc-200 dark:border-zinc-800 last:border-r-0 ${className}`}>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        {icon}
        <span className="font-semibold text-sm text-zinc-700 dark:text-zinc-200 uppercase tracking-wide">{title}</span>
      </div>
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}

// ── Board Card ─────────────────────────────────────────────────────────

function BoardCard({ board, active, onClick }: { board: KanbanBoardSummary; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 rounded-lg transition-colors ${
        active
          ? 'bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800'
          : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
      }`}
    >
      <div className="font-medium text-sm text-zinc-800 dark:text-zinc-100">{board.name}</div>
      <div className="flex items-center gap-3 mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
        <span>{board.taskCount} tasks</span>
        {board.activeTaskCount > 0 && (
          <span className="text-amber-600 dark:text-amber-400">{board.activeTaskCount} active</span>
        )}
        {board.doneTaskCount > 0 && (
          <span className="text-emerald-600 dark:text-emerald-400">{board.doneTaskCount} done</span>
        )}
      </div>
    </button>
  );
}

// ── Task Card ──────────────────────────────────────────────────────────

function TaskCard({ task, active, onClick }: {
  task: KanbanTaskInfo; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 rounded-lg transition-colors ${
        active
          ? 'bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800'
          : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
      }`}
    >
      <div className="flex items-start gap-2">
        <span className={`shrink-0 inline-block px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide ${statusColor(task.status)}`}>
          {task.status}
        </span>
        <span className="text-sm text-zinc-800 dark:text-zinc-100 line-clamp-2 font-medium">{task.title}</span>
      </div>
      {task.assignee && (
        <div className="mt-1.5 text-xs text-zinc-400 dark:text-zinc-500">{task.assignee}</div>
      )}
    </button>
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
      {/* Board link */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-1">Board</h3>
        <span className="inline-flex items-center gap-1.5 text-sm font-mono text-zinc-600 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-900 rounded px-2 py-1">
          <ExternalLink size={12} className="text-zinc-400" />
          {kanbanPath}
        </span>
      </div>

      {/* Status counts */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-2">Status</h3>
        <div className="grid grid-cols-2 gap-2">
          <CountBadge label="Total" count={counts.total} color="text-zinc-600 dark:text-zinc-300" />
          <CountBadge label="Done" count={counts.done} color="text-emerald-600 dark:text-emerald-400" />
          <CountBadge label="Running" count={counts.running} color="text-amber-600 dark:text-amber-400" />
          <CountBadge label="Blocked" count={counts.blocked} color="text-red-600 dark:text-red-400" />
          <CountBadge label="Ready" count={counts.ready} color="text-sky-600 dark:text-sky-400" />
          <CountBadge label="Review" count={counts.review} color="text-indigo-600 dark:text-indigo-400" />
        </div>
      </div>
    </div>
  );
}

function CountBadge({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className="flex items-center justify-between px-2 py-1 rounded bg-zinc-50 dark:bg-zinc-900/50">
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className={`text-sm font-bold ${color}`}>{count}</span>
    </div>
  );
}

// ── Task detail (right panel, when task selected) ──────────────────────

function TaskDetail({
  boardName, task, onBack,
}: {
  boardName: string; task: KanbanTaskInfo; onBack: () => void;
}) {
  const [blockers, setBlockers] = useState<{ kanban_id: string; title: string; status: string }[]>([]);
  const [blockersLoading, setBlockersLoading] = useState(false);

  useEffect(() => {
    if (task.status !== 'blocked') return;
    setBlockersLoading(true);
    fetchBoardTaskBlockers(boardName, task.kanban_id)
      .then((res) => setBlockers(res.blockers))
      .catch(() => {})
      .finally(() => setBlockersLoading(false));
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
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────

export function KanbanPage() {
  const [boards, setBoards] = useState<KanbanBoardSummary[]>([]);
  const [tasks, setTasks] = useState<KanbanTaskInfo[]>([]);
  const selectedBoard = useStore((s) => s.kanbanSelectedBoard);
  const selectedTask = useStore((s) => s.kanbanSelectedTask);
  const setKanbanSelection = useStore((s) => s.setKanbanSelection);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchKanbanBoards()
      .then((res) => setBoards(res.boards))
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (!selectedBoard) return;
    setLoading(true);
    fetchBoardTasks(selectedBoard)
      .then((res) => setTasks(res.tasks))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedBoard]);

  function selectBoard(name: string) {
    setKanbanSelection(name, null);
  }

  const selectedBoardSummary = boards.find((b) => b.name === selectedBoard);
  const selectedTaskInfo = tasks.find((t) => t.kanban_id === selectedTask);

  // ── Horizontal swipe + scroll-position memory (mobile) ──────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const saved = sessionStorage.getItem('kanban.scrollX');
    if (saved) el.scrollLeft = Number(saved);
    const onScroll = () => sessionStorage.setItem('kanban.scrollX', String(el.scrollLeft));
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // ── Determine what the right panel shows ────────────────────────────
  let rightPanelContent: React.ReactNode;
  if (selectedTaskInfo && selectedBoard) {
    rightPanelContent = (
      <TaskDetail
        boardName={selectedBoard}
        task={selectedTaskInfo}
        onBack={() => setKanbanSelection(selectedBoard, null)}
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
    <div
      ref={scrollRef}
      className="flex flex-1 min-h-0 snap-x snap-mandatory overflow-x-auto overscroll-x-contain md:snap-none md:overflow-x-hidden"
    >
      {/* BOARD LIST */}
      <Panel title="Boards" icon={<Columns3 size={16} className="text-indigo-500" />} className="w-[78vw] max-w-[280px] shrink-0 snap-start md:w-56 md:shrink">
        <div className="p-2 space-y-1">
          {boards.map((b) => (
            <BoardCard key={b.name} board={b} active={selectedBoard === b.name} onClick={() => selectBoard(b.name)} />
          ))}
        </div>
      </Panel>

      {/* TASK LIST */}
      <Panel title="Tasks" icon={<Layers size={16} className="text-indigo-500" />} className="w-[82vw] max-w-[320px] shrink-0 snap-start md:w-64 md:shrink">
        {loading && !tasks.length ? (
          <div className="flex items-center justify-center py-12"><Loader2 size={20} className="animate-spin text-zinc-400" /></div>
        ) : (
          <div className="p-2 space-y-1">
            {tasks.map((t) => (
              <TaskCard
                key={t.kanban_id}
                task={t}
                active={selectedTask === t.kanban_id}
                onClick={() => setKanbanSelection(selectedBoard, t.kanban_id)}
              />
            ))}
          </div>
        )}
      </Panel>

      {/* DETAIL (clean) */}
      <Panel title="Detail" icon={<span className="text-indigo-500 text-sm font-bold">i</span>} className="w-[90vw] shrink-0 snap-start md:w-auto md:flex-1 md:shrink">
        {rightPanelContent}
      </Panel>
    </div>
  );
}
