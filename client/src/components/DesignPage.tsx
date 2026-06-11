import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Code2,
  Eye,
  FileText,
  Loader2,
  Palette,
  Plus,
  RefreshCw,
  Save,
  Send,
  Sparkles,
  Square,
} from 'lucide-react';
import type { FileEntry, FileReadResponse } from '@shared/types';
import {
  ApiError,
  createFileEntry,
  createTask,
  interruptTask,
  listFiles,
  readFile,
  writeFile,
  WORKSPACE_ROOT,
} from '../lib/api';
import { useChat } from '../hooks/useChat';
import { formatDate, toErrorMessage } from '../lib/format';

const DESIGNS_DIR = `${WORKSPACE_ROOT}/designs`;
const TASK_MAP_KEY = 'agentcontrol.design.tasks';

const EXAMPLE_HTML = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AgentSelly — Beispiel-Design</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: #e2e8f0; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; padding: 2rem;
    }
    .card {
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px; padding: 2.5rem; max-width: 420px; width: 100%;
      backdrop-filter: blur(12px); box-shadow: 0 20px 60px rgba(0,0,0,0.4);
    }
    .badge {
      display: inline-block; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.08em;
      text-transform: uppercase; color: #38bdf8; background: rgba(56,189,248,0.12);
      padding: 0.3rem 0.7rem; border-radius: 999px; margin-bottom: 1.25rem;
    }
    h1 { font-size: 1.8rem; line-height: 1.2; margin-bottom: 0.75rem; }
    p { color: #94a3b8; line-height: 1.6; margin-bottom: 1.75rem; }
    .btn {
      display: inline-flex; align-items: center; gap: 0.5rem; background: #38bdf8;
      color: #0f172a; font-weight: 600; border: none; padding: 0.8rem 1.4rem;
      border-radius: 12px; cursor: pointer; font-size: 0.95rem;
      transition: transform 0.15s ease, background 0.15s ease;
    }
    .btn:hover { background: #7dd3fc; transform: translateY(-1px); }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">Beispiel</span>
    <h1>Dein erstes Design</h1>
    <p>Sag Claude unten, was du ändern willst — Farben, Texte, Layout. Die Vorschau aktualisiert sich automatisch.</p>
    <button class="btn">Loslegen →</button>
  </div>
</body>
</html>
`;

type TaskMap = Record<string, string>;

function loadTaskMap(): TaskMap {
  try {
    const raw = localStorage.getItem(TASK_MAP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as TaskMap) : {};
  } catch {
    return {};
  }
}

function saveTaskMap(map: TaskMap): void {
  try {
    localStorage.setItem(TASK_MAP_KEY, JSON.stringify(map));
  } catch {
    // storage disabled — task linkage is best-effort
  }
}

function isHtmlEntry(entry: FileEntry): boolean {
  if (entry.type !== 'file') return false;
  const lower = entry.name.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

export function DesignPage() {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [needsInit, setNeedsInit] = useState(false);
  const [initBusy, setInitBusy] = useState(false);

  const [selected, setSelected] = useState<FileReadResponse | null>(null);
  const [content, setContent] = useState('');
  const [loadingFile, setLoadingFile] = useState(false);
  const [mode, setMode] = useState<'preview' | 'code'>('preview');
  const [saving, setSaving] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);

  const [instruction, setInstruction] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [liveReload, setLiveReload] = useState(true);

  const { messages, isStreaming, activeTools, sendMessage, loadMessages, reset } = useChat();
  const wasStreamingRef = useRef(false);
  const editingTaskRef = useRef<{ taskId: string; path: string } | null>(null);
  const liveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastModifiedRef = useRef<string>('');

  const isDirty = selected ? content !== selected.content : false;

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const dir = await listFiles(DESIGNS_DIR);
      setEntries(dir.entries.filter(isHtmlEntry));
      setNeedsInit(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setEntries([]);
        setNeedsInit(true);
      } else {
        setListError(toErrorMessage(err, 'Designs konnten nicht geladen werden'));
      }
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const refreshSelected = useCallback(async (path: string) => {
    try {
      const file = await readFile(path);
      setSelected(file);
      setContent(file.content);
      setPreviewNonce((n) => n + 1);
    } catch (err) {
      setEditError(toErrorMessage(err, 'Datei konnte nicht neu geladen werden'));
    }
  }, []);

  // When Claude finishes a run that edited the open design, reload it.
  useEffect(() => {
    const finished = wasStreamingRef.current && !isStreaming;
    wasStreamingRef.current = isStreaming;
    if (!finished) return;
    const editing = editingTaskRef.current;
    if (editing && selected && editing.path === selected.path) {
      void refreshSelected(editing.path);
      void loadList();
    }
  }, [isStreaming, selected, refreshSelected, loadList]);

  const openDesign = useCallback(async (entry: FileEntry) => {
    if (isDirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return;
    setLoadingFile(true);
    setEditError(null);
    setMode('preview');
    try {
      const file = await readFile(entry.path);
      setSelected(file);
      setContent(file.content);
      setPreviewNonce((n) => n + 1);

      const taskId = loadTaskMap()[entry.path];
      if (taskId) await loadMessages(taskId).catch(() => undefined);
      else reset();
    } catch (err) {
      setEditError(toErrorMessage(err, 'Design konnte nicht geöffnet werden'));
    } finally {
      setLoadingFile(false);
    }
  }, [isDirty, loadMessages, reset]);

  const handleCreateExample = useCallback(async () => {
    setInitBusy(true);
    setListError(null);
    try {
      if (needsInit) {
        await createFileEntry(WORKSPACE_ROOT, 'designs', 'directory').catch((err) => {
          if (!(err instanceof ApiError && err.status === 409)) throw err;
        });
      }
      const name = `design-${Date.now()}.html`;
      const { entry } = await createFileEntry(DESIGNS_DIR, name, 'file', EXAMPLE_HTML);
      await loadList();
      await openDesign(entry);
    } catch (err) {
      setListError(toErrorMessage(err, 'Beispiel konnte nicht erstellt werden'));
    } finally {
      setInitBusy(false);
    }
  }, [needsInit, loadList, openDesign]);

  const handleSave = useCallback(async () => {
    if (!selected || !isDirty) return;
    setSaving(true);
    setEditError(null);
    try {
      const result = await writeFile(selected.path, content, selected.modifiedAt, true);
      setSelected({ ...selected, content, size: result.size, modifiedAt: result.modifiedAt });
      setPreviewNonce((n) => n + 1);
      await loadList();
    } catch (err) {
      setEditError(toErrorMessage(err, 'Speichern fehlgeschlagen'));
    } finally {
      setSaving(false);
    }
  }, [selected, content, isDirty, loadList]);

  const handleSendToClaude = useCallback(async () => {
    const text = instruction.trim();
    if (!selected || !text || isStreaming) return;
    if (isDirty && !window.confirm('Es gibt ungespeicherte manuelle Änderungen. Trotzdem an Claude senden? (Claude bearbeitet die Datei auf der Disk.)')) {
      return;
    }
    const designPath = selected.path;
    setEditError(null);
    try {
      let map = loadTaskMap();
      let taskId = map[designPath];
      if (!taskId) {
        const { task } = await createTask(
          `Design-Iteration für ${selected.name}`,
          `Design: ${selected.name}`,
        );
        taskId = task.id;
        map = { ...map, [designPath]: taskId };
        saveTaskMap(map);
        await loadMessages(taskId).catch(() => undefined);
      }
      editingTaskRef.current = { taskId, path: designPath };
      const message = [
        `Bearbeite diese HTML-Design-Datei direkt in place mit deinen Edit/Write-Tools: ${designPath}`,
        `Halte das HTML self-contained (inline CSS/JS oder CDN), damit es in einem iframe rendert. Keine langen Erklärungen nötig — mach die Änderung direkt.`,
        ``,
        `Änderungswunsch: ${text}`,
      ].join('\n');
      setInstruction('');
      const result = await sendMessage(taskId, message);
      if (!result.ok) setEditError(result.error);
    } catch (err) {
      setEditError(toErrorMessage(err, 'Anweisung konnte nicht gesendet werden'));
    }
  }, [instruction, selected, isStreaming, isDirty, sendMessage, loadMessages]);

  const handleStop = useCallback(async () => {
    const editing = editingTaskRef.current;
    if (!editing) return;
    await interruptTask(editing.taskId, 'Vom Nutzer gestoppt').catch(() => undefined);
  }, []);

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

  // Live reload: poll file every 2s when enabled and a design is open
  useEffect(() => {
    if (!liveReload || !selected || isStreaming) {
      if (liveIntervalRef.current) {
        clearInterval(liveIntervalRef.current);
        liveIntervalRef.current = null;
      }
      return;
    }
    lastModifiedRef.current = selected.modifiedAt;
    liveIntervalRef.current = setInterval(async () => {
      try {
        const file = await readFile(selected.path);
        if (file.modifiedAt !== lastModifiedRef.current) {
          lastModifiedRef.current = file.modifiedAt;
          setSelected(file);
          setContent(file.content);
          setPreviewNonce((n) => n + 1);
        }
      } catch {
        // file might be temporarily locked — skip this tick
      }
    }, 2000);
    return () => {
      if (liveIntervalRef.current) {
        clearInterval(liveIntervalRef.current);
        liveIntervalRef.current = null;
      }
    };
  }, [liveReload, selected?.path, isStreaming]);

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      {/* Gallery sidebar */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-950/40">
        <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
          <span className="flex items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
            <Palette size={15} />
            Designs
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void loadList()}
              title="Aktualisieren"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <RefreshCw size={14} className={loadingList ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              onClick={() => void handleCreateExample()}
              disabled={initBusy}
              title="Neues Design aus Beispiel"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-200/70 hover:text-zinc-900 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              {initBusy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={15} />}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {listError && (
            <p className="px-2 py-2 text-xs text-red-600 dark:text-red-400">{listError}</p>
          )}
          {loadingList && entries.length === 0 && (
            <p className="flex items-center gap-2 px-2 py-2 text-xs text-zinc-500">
              <Loader2 size={13} className="animate-spin" /> Lade Designs…
            </p>
          )}
          {!loadingList && entries.length === 0 && (
            <div className="px-2 py-6 text-center">
              <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
                Noch keine Designs in <code className="text-[11px]">designs/</code>.
              </p>
              <button
                type="button"
                onClick={() => void handleCreateExample()}
                disabled={initBusy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                <Plus size={13} /> Beispiel erstellen
              </button>
            </div>
          )}
          {entries.map((entry) => {
            const active = selected?.path === entry.path;
            return (
              <button
                key={entry.path}
                type="button"
                onClick={() => void openDesign(entry)}
                className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                  active
                    ? 'bg-zinc-200/80 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                    : 'text-zinc-700 hover:bg-zinc-200/50 dark:text-zinc-300 dark:hover:bg-zinc-800/60'
                }`}
              >
                <FileText size={14} className="shrink-0 text-zinc-400" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Main */}
      {!selected ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-zinc-400 dark:text-zinc-500">
          <Palette size={40} strokeWidth={1.4} />
          <p className="text-sm">Wähle links ein Design oder erstelle ein neues.</p>
          <p className="max-w-md text-xs">
            Designs leben in <code>~/.agentcontrol/workspace/designs/</code>. Self-contained HTML
            (inline CSS/JS) wird live gerendert. Claude passt sie über den Adapter an.
          </p>
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Toolbar */}
          <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {selected.name}
              </span>
              {isDirty && (
                <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                  ungespeichert
                </span>
              )}
              <span className="hidden text-xs text-zinc-400 sm:inline">
                {formatDate(selected.modifiedAt)}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => setLiveReload((prev) => !prev)}
                title={liveReload ? 'Live-Reload aktiv (alle 2s)' : 'Live-Reload inaktiv'}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-xs font-medium transition-colors ${
                  liveReload
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    : 'text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300'
                }`}
              >
                <RefreshCw size={13} className={liveReload ? 'opacity-100' : 'opacity-40'} />
              </button>
              <div className="flex rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-800">
                <button
                  type="button"
                  onClick={() => setMode('preview')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    mode === 'preview'
                      ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                  }`}
                >
                  <Eye size={13} /> Preview
                </button>
                <button
                  type="button"
                  onClick={() => setMode('code')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    mode === 'code'
                      ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                  }`}
                >
                  <Code2 size={13} /> Code
                </button>
              </div>
              <button
                type="button"
                onClick={() => void refreshSelected(selected.path)}
                title="Neu laden"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              >
                <RefreshCw size={14} className={loadingFile ? 'animate-spin' : ''} />
              </button>
              {mode === 'code' && (
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={!isDirty || saving}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 text-xs font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                >
                  {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                  Speichern
                </button>
              )}
            </div>
          </div>

          {editError && (
            <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              {editError}
            </div>
          )}

          {/* Canvas */}
          <div className="min-h-0 flex-1 overflow-hidden bg-zinc-100 dark:bg-zinc-900">
            {mode === 'preview' ? (
              <iframe
                key={previewNonce}
                srcDoc={content}
                title="Design preview"
                sandbox="allow-scripts allow-popups allow-forms"
                className="h-full w-full border-0 bg-white"
              />
            ) : (
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                spellCheck={false}
                className="h-full w-full resize-none border-0 bg-white p-4 font-mono text-xs leading-relaxed text-zinc-900 outline-none dark:bg-zinc-950 dark:text-zinc-100"
              />
            )}
          </div>

          {/* Claude edit bar */}
          <div className="border-t border-zinc-200 bg-surface px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
            {(isStreaming || lastAssistant) && (
              <div className="mb-2 max-h-24 overflow-y-auto rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
                {isStreaming ? (
                  <span className="flex items-center gap-2">
                    <Loader2 size={12} className="animate-spin" />
                    Claude arbeitet
                    {activeTools.length > 0 && (
                      <span className="text-zinc-400">
                        · {activeTools.map((t) => t.tool).join(', ')}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="whitespace-pre-wrap">{lastAssistant?.content?.slice(0, 400)}</span>
                )}
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void handleSendToClaude();
                  }
                }}
                rows={1}
                placeholder="Was soll Claude ändern? z.B. Button grün machen und Logo oben hinzufügen"
                className="min-h-[40px] flex-1 resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
              {isStreaming ? (
                <button
                  type="button"
                  onClick={() => void handleStop()}
                  className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <Square size={13} /> Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleSendToClaude()}
                  disabled={!instruction.trim()}
                  className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                >
                  <Sparkles size={14} /> Anpassen
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
