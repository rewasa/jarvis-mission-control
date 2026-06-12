import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, Fragment } from 'react';
import { ArrowUp, Loader2, ChevronDown, ChevronRight, Check, Terminal, FileText, FilePenLine, Globe, Code, Wrench, X, Target, Square, GitCompare, Copy } from 'lucide-react';
import { InputToolbar, ContextRing } from './InputToolbar';
import { AttachButton, AttachDropOverlay, AttachmentTray, UploadErrorBar } from './ChatAttachments';
import { MarkdownContent, DeferredMarkdown } from './MarkdownContent';
import { useChat, hasCachedConversation, ToolProgressEvent } from '../hooks/useChat';
import { useAgentConfig } from '../hooks/useAgentConfig';
import { useFileAttachments } from '../hooks/useFileAttachments';
import { handleChatKeyDown, toggleRunMode } from '../lib/keyboard';
import { ApiError, compactTask, interruptTask, type AgentRunSettings } from '../lib/api';
import { useStore } from '../lib/store';
import { SLASH_COMMANDS, slashCommandTokens, type SlashCommandDefinition } from '../lib/slashCommands';
import { GOAL_MODE_PLACEHOLDER, goalTurnLabel, toErrorMessage } from '../lib/format';
import type { ChatRunMode, GoalStateSnapshot } from '@shared/types';

interface TaskChatProps {
  taskId: string;
  initialMessage?: string;
  initialSettings?: AgentRunSettings;
}

type QueuedMessage = {
  id: string;
  content: string;
  settings: AgentRunSettings;
  error?: string | null;
};

function ThinkingBlock({ content, isLive }: { content: string; isLive: boolean }) {
  const [expanded, setExpanded] = useState(isLive);

  useEffect(() => {
    if (isLive) setExpanded(true);
  }, [isLive]);

  if (!content) return null;

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-xs text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{isLive ? 'Thinking…' : 'Thought process'}</span>
        {isLive && <Loader2 size={10} className="animate-spin" />}
      </button>
      {expanded && (
        <div className="mt-2 ml-1 pl-4 py-1 border-l-2 border-zinc-200 dark:border-zinc-700 text-xs text-zinc-400 dark:text-zinc-500 whitespace-pre-wrap break-words leading-relaxed max-h-60 overflow-y-auto overflow-x-hidden">
          {content}
        </div>
      )}
    </div>
  );
}

const TOOL_ICONS: Record<string, typeof Terminal> = {
  terminal: Terminal,
  process: Terminal,
  read_file: FileText,
  write_file: FilePenLine,
  patch: FilePenLine,
  execute_code: Code,
  web_search: Globe,
  web_extract: Globe,
  browser_navigate: Globe,
  browser_snapshot: Globe,
  browser_vision: Globe,
};

const CHAT_COLUMN_CLASS = 'w-full min-w-0 max-w-[760px] mx-auto';
const PLACEHOLDER_CLASS = 'text-sm text-zinc-400 dark:text-zinc-500 text-center py-12';
// How many of the most recent messages to render on first paint, and how many
// more to reveal each time the user asks for older history.
const INITIAL_VISIBLE_MESSAGES = 20;
const LOAD_MORE_STEP = 50;

function ConversationDivider({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2 text-xs text-zinc-400 dark:text-zinc-500">
      <div className="h-px min-w-6 flex-1 bg-zinc-200 dark:bg-zinc-800" />
      <span className="min-w-0 text-center leading-relaxed">{children}</span>
      <div className="h-px min-w-6 flex-1 bg-zinc-200 dark:bg-zinc-800" />
    </div>
  );
}

function getToolIcon(name: string) {
  return TOOL_ICONS[name] ?? Wrench;
}

function formatToolName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function DiffLine({ line }: { line: string }) {
  const tone = line.startsWith('+') && !line.startsWith('+++')
    ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
    : line.startsWith('-') && !line.startsWith('---')
      ? 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200'
      : line.startsWith('@@')
        ? 'bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200'
        : 'text-zinc-600 dark:text-zinc-400';
  return <div className={`min-w-max px-3 ${tone}`}>{line || ' '}</div>;
}

function GitDiffPreview({ tool }: { tool: ToolProgressEvent }) {
  const [expanded, setExpanded] = useState(false);
  const diff = tool.codeDiff;
  if (!diff) return null;

  const visibleFiles = diff.files.slice(0, 4);
  const lines = diff.patch ? diff.patch.split('\n').slice(0, expanded ? 220 : 36) : [];
  const hasMoreLines = diff.patch ? diff.patch.split('\n').length > lines.length : false;

  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950/70">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/70"
      >
        <GitCompare size={16} className="mt-0.5 shrink-0 text-indigo-500 dark:text-indigo-300" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">Live code diff</span>
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-200">
              {diff.fileCount} file{diff.fileCount === 1 ? '' : 's'} changed
            </span>
            {diff.truncated && (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-200">
                preview truncated
              </span>
            )}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap gap-1.5">
            {visibleFiles.map((file) => (
              <span key={`${file.status}-${file.path}`} className="max-w-full truncate rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {file.status} {file.path}
              </span>
            ))}
            {diff.fileCount > visibleFiles.length && (
              <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                +{diff.fileCount - visibleFiles.length} more
              </span>
            )}
          </div>
        </div>
        {expanded ? <ChevronDown size={14} className="mt-1 shrink-0 text-zinc-400" /> : <ChevronRight size={14} className="mt-1 shrink-0 text-zinc-400" />}
      </button>
      {expanded && (
        <div className="border-t border-zinc-200 dark:border-zinc-800">
          {diff.stat && (
            <pre className="overflow-x-auto whitespace-pre px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{diff.stat}</pre>
          )}
          {lines.length > 0 && (
            <div className="max-h-96 overflow-auto border-t border-zinc-100 bg-zinc-50 py-2 font-mono text-[11px] leading-5 dark:border-zinc-900 dark:bg-zinc-950">
              {lines.map((line, index) => <DiffLine key={index} line={line} />)}
              {hasMoreLines && <div className="px-3 pt-1 text-zinc-400">… expand preview limit reached</div>}
            </div>
          )}
          <div className="flex items-center justify-between gap-3 border-t border-zinc-100 px-3 py-2 text-[11px] text-zinc-400 dark:border-zinc-900">
            <span>Captured after tool completion · unstaged + staged diff</span>
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(diff.patch)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <Copy size={11} /> Copy patch
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolCallBlock({ tool }: { tool: ToolProgressEvent }) {
  const Icon = getToolIcon(tool.tool);
  return (
    <div className={`rounded-xl border px-4 py-2.5 ${
      tool.status === 'error'
        ? 'border-red-200 dark:border-red-900'
        : 'border-zinc-200 dark:border-zinc-700'
    }`}>
      <div className="flex items-center gap-2.5">
        <Icon size={14} className="text-zinc-400 dark:text-zinc-500 shrink-0" />
        <span className={`text-sm font-medium shrink-0 ${
          tool.status === 'error'
            ? 'text-red-500 dark:text-red-400'
            : 'text-zinc-600 dark:text-zinc-300'
        }`}>
          {formatToolName(tool.tool)}
        </span>
        {tool.label && (
          <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono truncate min-w-0">
            {tool.label}
          </span>
        )}
        {tool.status === 'running' && <Loader2 size={14} className="animate-spin text-zinc-400 shrink-0" />}
        {tool.status === 'completed' && <Check size={14} className="text-zinc-400 shrink-0" />}
        {tool.duration != null && (
          <span className="text-xs text-zinc-300 dark:text-zinc-600 ml-auto shrink-0 tabular-nums">
            {tool.duration.toFixed(1)}s
          </span>
        )}
      </div>
      <GitDiffPreview tool={tool} />
    </div>
  );
}

// --- Claude Code adapter tool rendering -------------------------------------
// The Claude subscription adapter can't emit real Anthropic tool_use blocks
// (Hermes would try to dispatch "Bash" itself), so it inlines its native tool
// calls/results into the assistant text stream as base64 sentinels:
//   [[HF_TOOL_CALL:<b64-json>]]   and   [[HF_TOOL_RESULT:<b64-json>]]
// We parse them here and render the SAME ToolCallBlock pills the native
// providers use, so the Claude adapter looks identical in the chat view.
const HF_TOOL_MARKER_RE = /\[\[HF_TOOL_(CALL|RESULT):([A-Za-z0-9+/=]+)\]\]/g;

function decodeUtf8Base64(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

// Map Claude Code tool names onto AgentControl-native tool keys so the icon and
// formatted label match the other providers exactly. Unmapped names fall back
// to their own (lower-cased) key → Wrench icon, same as native unknown tools.
const CLAUDE_TOOL_MAP: Record<string, { tool: string; labelKey?: string }> = {
  bash: { tool: 'terminal', labelKey: 'command' },
  read: { tool: 'read_file', labelKey: 'file_path' },
  write: { tool: 'write_file', labelKey: 'file_path' },
  edit: { tool: 'patch', labelKey: 'file_path' },
  multiedit: { tool: 'patch', labelKey: 'file_path' },
  notebookedit: { tool: 'patch', labelKey: 'notebook_path' },
  webfetch: { tool: 'web_extract', labelKey: 'url' },
  websearch: { tool: 'web_search', labelKey: 'query' },
  glob: { tool: 'glob', labelKey: 'pattern' },
  grep: { tool: 'grep', labelKey: 'pattern' },
  task: { tool: 'task', labelKey: 'description' },
  todowrite: { tool: 'todo_write' },
};

interface ClaudeToolCall { name: string; input?: Record<string, unknown>; id?: string }
interface ClaudeToolResult { id?: string; output?: string; is_error?: boolean }
type ClaudeSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; call?: ClaudeToolCall; result?: ClaudeToolResult };

function hasClaudeToolMarkers(content: string): boolean {
  return content.includes('[[HF_TOOL_');
}

function parseClaudeSegments(content: string): ClaudeSegment[] {
  const segments: ClaudeSegment[] = [];
  let lastIndex = 0;
  HF_TOOL_MARKER_RE.lastIndex = 0;
  const pushText = (text: string) => {
    if (text) segments.push({ kind: 'text', text });
  };
  let m: RegExpExecArray | null;
  while ((m = HF_TOOL_MARKER_RE.exec(content)) !== null) {
    pushText(content.slice(lastIndex, m.index));
    lastIndex = m.index + m[0].length;
    let payload: ClaudeToolCall & ClaudeToolResult;
    try {
      payload = JSON.parse(decodeUtf8Base64(m[2]));
    } catch {
      continue;
    }
    if (m[1] === 'CALL') {
      segments.push({ kind: 'tool', call: payload });
    } else {
      // Attach the result to the most recent call pill missing one.
      const last = segments[segments.length - 1];
      if (last && last.kind === 'tool' && !last.result) {
        last.result = payload;
      } else {
        segments.push({ kind: 'tool', result: payload });
      }
    }
  }
  pushText(content.slice(lastIndex));
  return segments;
}

function claudeToolKey(call?: ClaudeToolCall): string {
  const name = (call?.name || 'tool').toLowerCase();
  return CLAUDE_TOOL_MAP[name]?.tool ?? name;
}

function claudeToolLabel(call?: ClaudeToolCall): string | undefined {
  const key = CLAUDE_TOOL_MAP[(call?.name || '').toLowerCase()]?.labelKey;
  const raw = key && call?.input ? call.input[key] : undefined;
  const value = typeof raw === 'string' ? raw : undefined;
  if (!value) return undefined;
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
}

function ClaudeToolSegment({ call, result }: { call?: ClaudeToolCall; result?: ClaudeToolResult }) {
  const status: ToolProgressEvent['status'] = result?.is_error ? 'error' : 'completed';
  const tool = { tool: claudeToolKey(call), status, label: claudeToolLabel(call) } as ToolProgressEvent;
  return (
    <div className="my-2.5">
      <ToolCallBlock tool={tool} />
      {result?.output && (
        <details className="mt-1.5 ml-1.5 border-l-2 border-zinc-200 pl-3 dark:border-zinc-800">
          <summary className="cursor-pointer text-[11px] text-zinc-400 transition-colors hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300">
            Tool output
          </summary>
          <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400">
            {result.output}
          </pre>
        </details>
      )}
    </div>
  );
}

function ClaudeAdapterContent({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  const segments = useMemo(() => parseClaudeSegments(content), [content]);
  let lastTextIdx = -1;
  segments.forEach((seg, i) => {
    if (seg.kind === 'text' && seg.text.trim()) lastTextIdx = i;
  });
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === 'text') {
          return seg.text.trim() ? (
            <MarkdownContent key={i} content={seg.text} isStreaming={isStreaming && i === lastTextIdx} />
          ) : null;
        }
        return <ClaudeToolSegment key={i} call={seg.call} result={seg.result} />;
      })}
    </>
  );
}

function CommandSuggestionList({
  input,
  selectedIndex,
  onHover,
  onSelect,
}: {
  input: string;
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (definition: SlashCommandDefinition) => void;
}) {
  const trimmedStart = input.trimStart();
  if (/^\/\S+\s/.test(trimmedStart)) return null;
  const query = trimmedStart.slice(1).split(/\s/, 1)[0]?.toLowerCase() ?? '';
  const suggestions = useMemo(() => {
    if (!trimmedStart.startsWith('/')) return [];
    return SLASH_COMMANDS.filter((definition) => {
      const tokens = slashCommandTokens(definition).map((token) => token.slice(1).toLowerCase());
      if (!query) return true;
      return tokens.some((token) => token.startsWith(query) || token.includes(query));
    }).slice(0, 8);
  }, [query, trimmedStart]);

  if (suggestions.length === 0) return null;

  const activeSuggestion = suggestions[Math.min(selectedIndex, suggestions.length - 1)] ?? suggestions[0];

  return (
    <div className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
      <div className="flex items-center justify-between gap-3 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Hermes commands</div>
          <div className="truncate text-[11px] text-zinc-400 dark:text-zinc-500">↑/↓ select · Tab/Enter insert · Esc close</div>
        </div>
        {activeSuggestion && (
          <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
            {activeSuggestion.category}
          </span>
        )}
      </div>
      <div className="grid max-h-80 grid-cols-1 overflow-hidden sm:grid-cols-[minmax(0,1fr)_minmax(220px,0.75fr)]">
        <div className="max-h-80 overflow-y-auto p-1.5">
          {suggestions.map((definition, index) => {
            const active = index === Math.min(selectedIndex, suggestions.length - 1);
            return (
              <button
                key={definition.command}
                type="button"
                onMouseEnter={() => onHover(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(definition);
                }}
                className={`flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left transition-colors ${active ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60'}`}
              >
                <span className="mt-0.5 font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">{definition.command}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-500 dark:text-zinc-400">
                  {definition.args ?? definition.aliases?.join(', ') ?? definition.category}
                </span>
                {definition.agentControl && (
                  <span className="shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-300">
                    AC
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="hidden border-l border-zinc-100 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-950/30 sm:block">
          <div className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {activeSuggestion.command} {activeSuggestion.args ?? ''}
          </div>
          {activeSuggestion.aliases && (
            <div className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">Aliases: {activeSuggestion.aliases.join(', ')}</div>
          )}
          <p className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">{activeSuggestion.description}</p>
          {!activeSuggestion.agentControl && (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
              Hermes command reference. AgentControl may send unsupported commands as normal chat text unless a server handler exists.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
function QueuedMessageBar({
  queuedMessages,
  isSending,
  canRetry,
  waitingLabel,
  onRemove,
  onRetry,
}: {
  queuedMessages: QueuedMessage[];
  isSending: boolean;
  canRetry: boolean;
  waitingLabel: string;
  onRemove: (id: string) => void;
  onRetry: (message: QueuedMessage) => void;
}) {
  const firstError = queuedMessages.find((message) => message.error)?.error ?? null;
  const statusLabel = isSending ? 'Sending...' : firstError ?? waitingLabel;

  return (
    <div className="mx-3 mb-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900/60 sm:mx-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <span className="shrink-0 rounded-md bg-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
              Queue ×{queuedMessages.length}
            </span>
            <span className={`min-w-0 truncate text-xs ${firstError ? 'text-red-500' : 'text-zinc-500 dark:text-zinc-400'}`}>
              {statusLabel}
            </span>
          </div>
          <div className="space-y-1.5">
            {queuedMessages.map((queuedMessage, index) => (
              <div key={queuedMessage.id} className="flex min-w-0 items-center gap-2 rounded-md bg-white/70 px-2 py-1 dark:bg-zinc-950/30">
                <span className="shrink-0 text-[10px] font-semibold tabular-nums text-zinc-400 dark:text-zinc-500">
                  {index + 1}
                </span>
                <p className="min-w-0 flex-1 truncate text-sm text-zinc-700 dark:text-zinc-200">
                  {queuedMessage.content}
                </p>
                {queuedMessage.error && canRetry && (
                  <button
                    type="button"
                    onClick={() => onRetry(queuedMessage)}
                    className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-200 dark:text-zinc-200 dark:hover:bg-zinc-700"
                  >
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onRemove(queuedMessage.id)}
                  disabled={isSending && index === 0}
                  aria-label="Remove queued message"
                  title="Remove queued message"
                  className="shrink-0 rounded-md p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 disabled:opacity-40 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function GoalRunStatus({ goal }: { goal: GoalStateSnapshot | null | undefined }) {
  const turnLabel = goal ? goalTurnLabel(goal.turnsUsed ?? 0, goal.maxTurns ?? 0) : null;

  return (
    <div className={`${CHAT_COLUMN_CLASS} mb-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-800 shadow-sm dark:border-zinc-700 dark:bg-zinc-900/70 dark:text-zinc-100`}>
      <div className="flex min-w-0 items-center gap-2 overflow-hidden">
        <Target size={14} strokeWidth={2.5} className="shrink-0" />
        <span className="shrink-0 font-semibold">Goal active</span>
        {turnLabel && (
          <span className="shrink-0 rounded-full border border-zinc-200 bg-white px-2 py-0.5 font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
            {turnLabel}
          </span>
        )}
        <span className="min-w-0 truncate text-zinc-500 dark:text-zinc-400">
          Hermes will continue if more work remains.
        </span>
      </div>
    </div>
  );
}

function useSyncedDraft(taskId: string): [string, React.Dispatch<React.SetStateAction<string>>] {
  const key = `agentcontrol.draft.${taskId}`;
  const channelRef = useRef<BroadcastChannel | null>(null);
  const [input, setInputState] = useState(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(key) ?? '';
  });

  useEffect(() => {
    setInputState(window.localStorage.getItem(key) ?? '');
    
    // BroadcastChannel works flawlessly across Safari tabs without needing 
    // to rely on the sometimes-throttled StorageEvent.
    const channel = new BroadcastChannel(key);
    channelRef.current = channel;
    channel.onmessage = (e) => setInputState(e.data);

    const handleStorage = (e: StorageEvent) => {
      if (e.key === key) setInputState(e.newValue ?? '');
    };
    window.addEventListener('storage', handleStorage);
    
    return () => {
      channel.close();
      channelRef.current = null;
      window.removeEventListener('storage', handleStorage);
    };
  }, [key]);

  const setInput = useCallback<React.Dispatch<React.SetStateAction<string>>>((val) => {
    setInputState((prev) => {
      const next = typeof val === 'function' ? val(prev) : val;
      if (next) {
        window.localStorage.setItem(key, next);
      } else {
        window.localStorage.removeItem(key);
      }
      channelRef.current?.postMessage(next || '');
      return next;
    });
  }, [key]);

  return [input, setInput];
}

function useSyncedQueue(taskId: string): [QueuedMessage[], React.Dispatch<React.SetStateAction<QueuedMessage[]>>] {
  const key = `agentcontrol.queue.${taskId}`;
  const channelRef = useRef<BroadcastChannel | null>(null);
  const [queue, setQueueState] = useState<QueuedMessage[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const stored = window.localStorage.getItem(key);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      setQueueState(stored ? JSON.parse(stored) : []);
    } catch {}
    
    const channel = new BroadcastChannel(key);
    channelRef.current = channel;
    channel.onmessage = (e) => setQueueState(e.data);

    const handleStorage = (e: StorageEvent) => {
      if (e.key === key) {
        try {
          setQueueState(e.newValue ? JSON.parse(e.newValue) : []);
        } catch {}
      }
    };
    window.addEventListener('storage', handleStorage);
    
    return () => {
      channel.close();
      channelRef.current = null;
      window.removeEventListener('storage', handleStorage);
    };
  }, [key]);

  const setQueue = useCallback<React.Dispatch<React.SetStateAction<QueuedMessage[]>>>((val) => {
    setQueueState((prev) => {
      const next = typeof val === 'function' ? val(prev) : val;
      if (next.length > 0) {
        window.localStorage.setItem(key, JSON.stringify(next));
      } else {
        window.localStorage.removeItem(key);
      }
      channelRef.current?.postMessage(next);
      return next;
    });
  }, [key]);

  return [queue, setQueue];
}

export function TaskChat({ taskId, initialMessage, initialSettings }: TaskChatProps) {
  const { messages, isStreaming: liveIsStreaming, stopped: runStopped, thinkingContent, activeTools, context, sendMessage, loadMessages } = useChat();
  const taskRun = useStore((s) => s.taskRuns.get(taskId));
  const taskDescription = useStore((s) => s.tasks.find((t) => t.id === taskId)?.description ?? '');
  const [input, setInput] = useSyncedDraft(taskId);
  const [runMode, setRunMode] = useState<ChatRunMode>(initialSettings?.mode ?? 'task');
  const [loadedTaskId, setLoadedTaskId] = useState<string | null>(null);
  const [messageLoadError, setMessageLoadError] = useState(false);
  const [compactInFlight, setCompactInFlight] = useState(false);
  const [compactDone, setCompactDone] = useState(false);
  const [compactAfterIndex, setCompactAfterIndex] = useState(-1);
  const [queuedMessages, setQueuedMessages] = useSyncedQueue(taskId);
  const [autoSendingQueuedId, setAutoSendingQueuedId] = useState<string | null>(null);
  const [outgoingRevealActive, setOutgoingRevealActive] = useState(false);
  const [interruptInFlight, setInterruptInFlight] = useState(false);
  const [interruptError, setInterruptError] = useState<string | null>(null);
  const [commandSuggestionIndex, setCommandSuggestionIndex] = useState(0);
  // Windowing: large conversations (1000+ messages) would otherwise mount every
  // Markdown/Shiki block at once, freezing the first paint. Render only the most
  // recent slice (the chat scrolls to the bottom anyway) and let the user pull in
  // older messages on demand.
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const {
    pendingFiles,
    dragOver,
    uploadError,
    setUploadError,
    hasUploadingFiles,
    uploadBlocksSend,
    sendBlockedLabel,
    addFiles,
    removeFile,
    retryFile,
    clearFiles,
    submitWithAttachments,
    dragHandlers,
    handlePaste,
  } = useFileAttachments(taskId);
  const startupRef = useRef({ taskId, initialMessage, initialSettings });
  if (startupRef.current.taskId !== taskId) {
    startupRef.current = { taskId, initialMessage, initialSettings };
  }
  const { defaults, modelGroups, model, setModel, provider, setProvider, reasoningEffort, setReasoningEffort, isLoading } = useAgentConfig(
    taskId,
    startupRef.current.initialSettings,
  );
  // Render the toolbar as soon as we have defaults to show — whether they came
  // from the live fetch or the localStorage cache. Only the genuine cold-start
  // case (no cached defaults at all) keeps the input disabled.
  const toolbarDefaults = defaults;
  const configPending = !defaults && isLoading;
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const latestUserMessageRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const didInitialScrollRef = useRef(false);
  const pendingAutoSendRef = useRef<string | null>(null);
  const pendingRevealRef = useRef(false);
  const queuedMessagesRef = useRef<QueuedMessage[]>([]);
  const lastGoalStatusRef = useRef<GoalStateSnapshot['status'] | null>(null);

  const runIsStreaming = (taskRun?.kind === 'chat' || taskRun?.kind === 'goal') && taskRun.status === 'streaming';
  const isGoalStreaming = taskRun?.kind === 'goal' && taskRun.status === 'streaming';
  const isStreaming = liveIsStreaming || runIsStreaming;
  const isCompacting = taskRun?.kind === 'compact' && taskRun.status === 'compacting';
  const compactionBlocker = isCompacting || compactInFlight;
  const taskBusyForQueue = isStreaming || compactionBlocker;
  const queuedIsSending = queuedMessages.some((message) => message.id === autoSendingQueuedId);
  const hasQueuedMessages = queuedMessages.length > 0;
  const latestUserMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].id;
    }
    return null;
  }, [messages]);

  const commandSuggestions = useMemo(() => {
    const trimmedStart = input.trimStart();
    if (!trimmedStart.startsWith('/') || /^\/\S+\s/.test(trimmedStart)) return [];
    const query = trimmedStart.slice(1).split(/\s/, 1)[0]?.toLowerCase() ?? '';
    return SLASH_COMMANDS.filter((definition) => {
      const tokens = slashCommandTokens(definition).map((token) => token.slice(1).toLowerCase());
      if (!query) return true;
      return tokens.some((token) => token.startsWith(query) || token.includes(query));
    }).slice(0, 8);
  }, [input]);
  const showCommandSuggestions = commandSuggestions.length > 0;

  useEffect(() => {
    queuedMessagesRef.current = queuedMessages;
  }, [queuedMessages]);

  useEffect(() => {
    if (!showCommandSuggestions) {
      setCommandSuggestionIndex(0);
      return;
    }
    setCommandSuggestionIndex((current) => Math.min(current, commandSuggestions.length - 1));
  }, [commandSuggestions.length, showCommandSuggestions]);

  useEffect(() => {
    const goalStatus = taskRun?.kind === 'goal' ? taskRun.goal?.status ?? null : null;
    const goalCompleted = goalStatus === 'done' || (!goalStatus && lastGoalStatusRef.current === 'done');

    if (goalCompleted) {
      setRunMode('task');
      setQueuedMessages((current) => {
        let changed = false;
        const next = current.map((message) => {
          if (message.settings.mode !== 'goal') return message;
          changed = true;
          return { ...message, settings: { ...message.settings, mode: 'task' as const } };
        });
        return changed ? next : current;
      });
    }

    lastGoalStatusRef.current = goalStatus;
  }, [taskRun?.kind, taskRun?.goal?.status]);

  useEffect(() => {
    let cancelled = false;
    // If we already have this conversation cached, skip the loading spinner —
    // loadMessages() republishes the cached messages synchronously below.
    setLoadedTaskId(hasCachedConversation(taskId) ? taskId : null);
    setMessageLoadError(false);
    setCompactInFlight(false);
    setCompactDone(false);
    setCompactAfterIndex(-1);
    setVisibleCount(INITIAL_VISIBLE_MESSAGES);
    setAutoSendingQueuedId(null);
    setRunMode(startupRef.current.initialSettings?.mode ?? 'task');
    setOutgoingRevealActive(false);
    setInterruptInFlight(false);
    setInterruptError(null);
    setUploadError(null);
    clearFiles();
    lastGoalStatusRef.current = null;
    queuedMessagesRef.current = [];
    pendingAutoSendRef.current = null;
    pendingRevealRef.current = false;
    didInitialScrollRef.current = false;
    loadMessages(taskId)
      .then((loadedMessages) => {
        if (cancelled) return;
        setLoadedTaskId(taskId);
        const firstMessage = startupRef.current.initialMessage;
        if (firstMessage) {
          startupRef.current.initialMessage = undefined;
          if (loadedMessages.length === 0) {
            pendingRevealRef.current = true;
            setOutgoingRevealActive(true);
            sendMessage(taskId, firstMessage, startupRef.current.initialSettings);
          }
        }
      })
      .catch(() => {
        if (cancelled) return;
        setMessageLoadError(true);
        setLoadedTaskId(taskId);
      });
    return () => { cancelled = true; };
  }, [taskId, loadMessages, sendMessage, clearFiles]);

  useEffect(() => {
    if (!configPending) inputRef.current?.focus();
  }, [configPending, taskId]);

  useLayoutEffect(() => {
    if (loadedTaskId !== taskId || didInitialScrollRef.current) return;

    const container = messagesContainerRef.current;
    if (!container) return;

    container.scrollTop = container.scrollHeight;
    didInitialScrollRef.current = true;
  }, [loadedTaskId, messages.length, taskId]);

  useLayoutEffect(() => {
    if (!compactInFlight && !compactDone) return;
    const container = messagesContainerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [compactInFlight, compactDone]);

  useLayoutEffect(() => {
    if (loadedTaskId !== taskId || !pendingRevealRef.current) return;

    const container = messagesContainerRef.current;
    const target = latestUserMessageRef.current;
    if (!container || !target) return;

    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const targetTop = container.scrollTop + targetRect.top - containerRect.top - 12;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: reduceMotion ? 'auto' : 'smooth',
    });

    pendingRevealRef.current = false;
  }, [latestUserMessageId, loadedTaskId, taskId]);

  const sendQueuedMessage = useCallback(async (message: QueuedMessage) => {
    if (pendingAutoSendRef.current) return;

    pendingAutoSendRef.current = message.id;
    pendingRevealRef.current = true;
    setAutoSendingQueuedId(message.id);
    setOutgoingRevealActive(true);
    setQueuedMessages((current) => current.map((item) => (
      item.id === message.id ? { ...item, error: null } : item
    )));

    const result = await sendMessage(taskId, message.content, message.settings, { appendLocalError: false });
    if (result.ok) {
      setQueuedMessages((current) => current.filter((item) => item.id !== message.id));
    } else if (queuedMessagesRef.current.some((item) => item.id === message.id)) {
      pendingRevealRef.current = false;
      setOutgoingRevealActive(false);
      setQueuedMessages((current) => current.map((item) => (
        item.id === message.id ? { ...item, error: result.error } : item
      )));
    }

    if (pendingAutoSendRef.current === message.id) pendingAutoSendRef.current = null;
    setAutoSendingQueuedId((current) => current === message.id ? null : current);
  }, [sendMessage, taskId]);

  useEffect(() => {
    const nextQueuedMessage = queuedMessages[0];
    if (!nextQueuedMessage || taskBusyForQueue || configPending || nextQueuedMessage.error) return;
    void sendQueuedMessage(nextQueuedMessage);
  }, [configPending, queuedMessages, sendQueuedMessage, taskBusyForQueue]);

  useEffect(() => {
    if (!isStreaming) setInterruptInFlight(false);
  }, [isStreaming]);

  // Safety net: the spinner normally clears when the stream ends, but if that
  // signal never arrives (e.g. the live SSE drops) don't leave it stuck forever.
  useEffect(() => {
    if (!interruptInFlight) return;
    const timer = setTimeout(() => setInterruptInFlight(false), 15_000);
    return () => clearTimeout(timer);
  }, [interruptInFlight]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    const hasFiles = pendingFiles.length > 0;
    if ((!text && !hasFiles) || configPending || uploadBlocksSend) return;

    const messageText = submitWithAttachments(text);

    const settings = { model, provider, reasoningEffort, mode: isGoalStreaming ? 'task' : runMode };
    const trimmedMessage = messageText.trimStart();
    const isSteerMessage = /^\/steer(?:\s+|$)/i.test(trimmedMessage);
    const forceQueue = /^\/queue(?:\s+|$)/i.test(trimmedMessage);
    const queueContent = trimmedMessage.replace(/^\/queue(?:\s+|$)/i, '').trim();
    const shouldQueue = (taskBusyForQueue || forceQueue) && !isSteerMessage;
    if (shouldQueue) {
      setQueuedMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          content: queueContent || messageText,
          settings,
          error: null,
        },
      ]);
      setInput('');
      return;
    }

    setInput('');
    pendingRevealRef.current = true;
    setOutgoingRevealActive(true);
    const result = await sendMessage(taskId, messageText, settings);
    if (!result.ok && result.conflict) {
      pendingRevealRef.current = false;
      setOutgoingRevealActive(false);
      setQueuedMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          content: queueContent || messageText,
          settings,
          error: null,
        },
      ]);
    }
  }, [submitWithAttachments, configPending, uploadBlocksSend, input, pendingFiles, model, provider, reasoningEffort, runMode, isGoalStreaming, taskBusyForQueue, sendMessage, taskId]);

  const handleCompact = useCallback(async () => {
    if (compactionBlocker || isStreaming) return;
    setCompactInFlight(true);
    setCompactDone(false);
    try {
      await compactTask(taskId);
      const compactedMessages = await loadMessages(taskId);
      setCompactAfterIndex(compactedMessages.length);
      setCompactDone(true);
    } catch (error) {
      if (queuedMessagesRef.current.length > 0) {
        setQueuedMessages((current) => current.map((message) => (
          message.error ? message : { ...message, error: toErrorMessage(error, 'Compaction failed') }
        )));
      }
      throw error;
    } finally {
      setCompactInFlight(false);
    }
  }, [compactionBlocker, isStreaming, loadMessages, taskId]);

  const handleInterrupt = useCallback(async () => {
    if (!isStreaming || interruptInFlight) return;
    setInterruptInFlight(true);
    setInterruptError(null);
    try {
      await interruptTask(taskId);
    } catch (error) {
      // 409 means the run already finished between render and click — nothing to stop, not a failure.
      if (!(error instanceof ApiError && error.status === 409)) {
        setInterruptError(toErrorMessage(error, 'Failed to stop Hermes'));
      }
      setInterruptInFlight(false);
    }
  }, [interruptInFlight, isStreaming, taskId]);

  const handleRemoveQueuedMessage = useCallback((id: string) => {
    if (autoSendingQueuedId === id) return;
    setQueuedMessages((current) => current.filter((message) => message.id !== id));
  }, [autoSendingQueuedId]);

  const handleRetryQueuedMessage = useCallback((message: QueuedMessage) => {
    if (taskBusyForQueue || configPending || autoSendingQueuedId) return;
    setQueuedMessages((current) => current.map((item) => (
      item.id === message.id ? { ...item, error: null } : item
    )));
    void sendQueuedMessage({ ...message, error: null });
  }, [autoSendingQueuedId, configPending, sendQueuedMessage, taskBusyForQueue]);

  const applySlashCommand = useCallback((definition: SlashCommandDefinition) => {
    const trimmedStart = input.trimStart();
    const leadingWhitespace = input.slice(0, input.length - trimmedStart.length);
    const commandText = `${definition.command} `;
    if (!trimmedStart.startsWith('/')) {
      setInput(`${leadingWhitespace}${commandText}`);
    } else {
      setInput(`${leadingWhitespace}${commandText}${trimmedStart.replace(/^\/\S*\s*/, '')}`);
    }
    setCommandSuggestionIndex(0);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [input]);

  const goalToggleDisabled = isStreaming || compactionBlocker || hasQueuedMessages;
  const handleToggleGoalMode = useCallback(() => setRunMode(toggleRunMode), []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showCommandSuggestions) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setCommandSuggestionIndex((current) => (current + 1) % commandSuggestions.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setCommandSuggestionIndex((current) => (current - 1 + commandSuggestions.length) % commandSuggestions.length);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          applySlashCommand(commandSuggestions[commandSuggestionIndex] ?? commandSuggestions[0]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setInput((current) => current.startsWith('/') ? '' : current);
          setCommandSuggestionIndex(0);
          return;
        }
      }

      handleChatKeyDown(e, handleSubmit, {
        onGoalToggle: handleToggleGoalMode,
        goalToggleDisabled,
      });
    },
    [applySlashCommand, commandSuggestionIndex, commandSuggestions, goalToggleDisabled, handleSubmit, handleToggleGoalMode, showCommandSuggestions],
  );
  const isLoadingMessages = loadedTaskId !== taskId;

  const [showLoadingSpinner, setShowLoadingSpinner] = useState(false);
  useEffect(() => {
    if (isLoadingMessages) {
      const timer = setTimeout(() => setShowLoadingSpinner(true), 150);
      return () => clearTimeout(timer);
    } else {
      setShowLoadingSpinner(false);
    }
  }, [isLoadingMessages]);

  // Only mount the most recent `visibleCount` messages. `windowStart` keeps the
  // original indices intact so the compaction-divider / last-assistant logic
  // below stays correct.
  const windowStart = Math.max(0, messages.length - visibleCount);
  const visibleMessages = windowStart > 0 ? messages.slice(windowStart) : messages;
  const hiddenCount = windowStart;

  const sendButton = isStreaming
    ? {
        onClick: handleInterrupt,
        disabled: interruptInFlight,
        label: interruptInFlight ? 'Stopping response' : 'Stop response',
        icon: interruptInFlight
          ? <Loader2 size={14} className="animate-spin" />
          : <Square size={11} fill="currentColor" strokeWidth={0} />,
      }
    : {
        onClick: handleSubmit,
        disabled: (!input.trim() && pendingFiles.length === 0) || configPending || uploadBlocksSend,
        label: sendBlockedLabel ?? 'Send message',
        icon: hasUploadingFiles ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={14} />,
      };

  return (
    <div
      className="relative flex w-full flex-col flex-1 min-h-0"
      {...dragHandlers}
    >
      {dragOver && <AttachDropOverlay />}
      <div className="relative flex-1 min-h-0">
        <div
          ref={messagesContainerRef}
          className="h-full overflow-y-auto overflow-x-hidden px-3 py-3 sm:px-6 sm:py-4"
        >
          <div className={`${CHAT_COLUMN_CLASS} space-y-3`}>
            {isLoadingMessages ? (
              showLoadingSpinner ? (
                <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-400 dark:text-zinc-500">
                  <Loader2 size={16} className="animate-spin" />
                  <span>Loading conversation...</span>
                </div>
              ) : null
            ) : messageLoadError ? (
              <p className={PLACEHOLDER_CLASS}>Unable to load conversation.</p>
            ) : messages.length === 0 ? (
              taskDescription.trim() ? (
                <div className="rounded-2xl border border-zinc-200 bg-zinc-50/60 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                    Task details
                  </p>
                  <div className="min-w-0 max-w-full overflow-hidden text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                    <MarkdownContent content={taskDescription.trim()} />
                  </div>
                </div>
              ) : (
                <p className={PLACEHOLDER_CLASS}>Start a conversation with your assistant.</p>
              )
            ) : null}
            {hiddenCount > 0 && (
              <div className="flex justify-center py-2">
                <button
                  type="button"
                  onClick={() => setVisibleCount((c) => c + LOAD_MORE_STEP)}
                  className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs text-zinc-500 transition-colors hover:text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
                >
                  Show earlier messages ({hiddenCount})
                </button>
              </div>
            )}
            {visibleMessages.map((msg, localIdx) => {
              const idx = windowStart + localIdx;
              const compactDivider = compactDone && idx === compactAfterIndex ? (
                <ConversationDivider>Conversation compacted</ConversationDivider>
              ) : null;

              if (msg.role === 'system') {
                return (
                  <Fragment key={msg.id}>
                    {compactDivider}
                    <ConversationDivider>{msg.content}</ConversationDivider>
                  </Fragment>
                );
              }

              if (msg.role === 'user') {
                const isLatestUserMessage = msg.id === latestUserMessageId;
                return (
                  <Fragment key={msg.id}>
                    {compactDivider}
                    <div ref={isLatestUserMessage ? latestUserMessageRef : undefined} className="flex min-w-0 justify-end">
                      <div className="min-w-0 max-w-[92%] overflow-hidden rounded-2xl bg-zinc-100 px-3.5 py-2.5 text-sm leading-relaxed text-zinc-900 whitespace-pre-wrap break-words dark:bg-zinc-800 dark:text-zinc-100 sm:max-w-[85%] sm:px-4">
                        {msg.content}
                      </div>
                    </div>
                  </Fragment>
                );
              }

              const isLastAssistant = idx === messages.length - 1 && msg.role === 'assistant';
              const thinkingToShow = isLastAssistant && isStreaming ? thinkingContent : (msg.thinking || '');
              const isLiveThinking = isLastAssistant && isStreaming && !!thinkingContent;
              const toolsToShow = isLastAssistant && isStreaming ? activeTools : (msg.tools ?? []);
              const showSpinner = isLastAssistant && isStreaming && !msg.content && !thinkingContent && !activeTools.some(t => t.status === 'running');

              return (
                <Fragment key={msg.id}>
                  {compactDivider}
                  <div className="flex min-w-0 justify-start">
                    <div className="min-w-0 w-full sm:px-2">
                      {thinkingToShow && (
                        <ThinkingBlock content={thinkingToShow} isLive={isLiveThinking} />
                      )}
                      {toolsToShow.length > 0 && (
                        <div className="mb-4 space-y-2.5">
                          {toolsToShow.map((tool, i) => (
                            <ToolCallBlock key={`${tool.tool}-${i}`} tool={tool} />
                          ))}
                        </div>
                      )}
                      <div className="min-w-0 max-w-full overflow-hidden text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                        {msg.content ? (
                          hasClaudeToolMarkers(msg.content) ? (
                            <ClaudeAdapterContent content={msg.content} isStreaming={isLastAssistant && isStreaming} />
                          ) : (
                            <MarkdownContent content={msg.content} isStreaming={isLastAssistant && isStreaming} />
                          )
                        ) : (
                          showSpinner && (
                            <span className="inline-flex items-center gap-2 text-zinc-400 dark:text-zinc-500">
                              <span>Thinking</span>
                              <span className="inline-flex gap-1">
                                {[0, 150, 300].map((delay) => (
                                  <span
                                    key={delay}
                                    className="w-1.5 h-1.5 rounded-full bg-current animate-pulse"
                                    style={{ animationDelay: `${delay}ms` }}
                                  />
                                ))}
                              </span>
                            </span>
                          )
                        )}
                      </div>
                    </div>
                  </div>
                </Fragment>
              );
            })}
            {runStopped && <ConversationDivider>Stopped by you</ConversationDivider>}
            {compactInFlight && (
              <ConversationDivider>
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 size={10} className="shrink-0 animate-spin" />
                  Compacting conversation…
                </span>
              </ConversationDivider>
            )}
            {compactDone && compactAfterIndex >= messages.length && (
              <ConversationDivider>Conversation compacted</ConversationDivider>
            )}
            {outgoingRevealActive && <div aria-hidden="true" className="h-[45vh] sm:h-[52vh]" />}
          </div>
        </div>
      </div>

      <div className="border-t border-zinc-100 px-3 py-3 dark:border-zinc-800 sm:px-6 sm:py-4">
        {isGoalStreaming && <GoalRunStatus goal={taskRun?.goal} />}
        <div className={`${CHAT_COLUMN_CLASS} relative rounded-xl border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800 sm:rounded-2xl`}>
          <CommandSuggestionList
            input={input}
            selectedIndex={commandSuggestionIndex}
            onHover={setCommandSuggestionIndex}
            onSelect={applySlashCommand}
          />
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={configPending}
            placeholder={runMode === 'goal' ? GOAL_MODE_PLACEHOLDER : 'Message your assistant...'}
            rows={2}
            className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base leading-relaxed text-zinc-900 placeholder-zinc-400 focus:outline-none disabled:opacity-60 dark:text-zinc-100 dark:placeholder-zinc-500 sm:px-5 sm:text-sm"
          />
          <AttachmentTray files={pendingFiles} onRemove={removeFile} onRetry={retryFile} />
          {uploadError && <UploadErrorBar error={uploadError} onDismiss={() => setUploadError(null)} />}
          {interruptError && <UploadErrorBar error={interruptError} onDismiss={() => setInterruptError(null)} />}
          {hasQueuedMessages && (
            <QueuedMessageBar
              queuedMessages={queuedMessages}
              isSending={queuedIsSending}
              canRetry={!taskBusyForQueue && !configPending && !queuedIsSending}
              waitingLabel={compactionBlocker ? 'Sends after compaction' : 'Sends after current response'}
              onRemove={handleRemoveQueuedMessage}
              onRetry={handleRetryQueuedMessage}
            />
          )}

          {taskRun?.usedModel && taskRun.usedModel !== model && taskRun.usedModel !== defaults?.model && (
            <div className="mx-3 sm:mx-4 mb-2 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
              <span className="font-medium">⚠️ Fallback / Router:</span>
              <span>
                Task actually executed using <strong>{taskRun.usedModel}</strong>
                {taskRun.usedProvider ? ` (via ${taskRun.usedProvider})` : ''}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 px-3 pb-3 sm:gap-3 sm:px-4">
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              <AttachButton onFiles={addFiles} disabled={configPending} />
              <InputToolbar
                model={model}
                provider={provider}
                reasoningEffort={reasoningEffort}
                runMode={runMode}
                defaults={toolbarDefaults}
                modelGroups={modelGroups}
                disabled={goalToggleDisabled}
                compactMobile
                onModelChange={(nextModel, nextProvider) => {
                  setModel(nextModel);
                  setProvider(nextProvider ?? null);
                }}
                onReasoningEffortChange={setReasoningEffort}
                onRunModeChange={setRunMode}
              />
            </div>
            <div className="flex items-center gap-2">
              {context && (
                <ContextRing
                  context={context}
                  onCompact={handleCompact}
                  compacting={compactionBlocker}
                  compactDisabled={isStreaming || configPending || hasQueuedMessages}
                />
              )}
              <button
                type="button"
                onClick={sendButton.onClick}
                disabled={sendButton.disabled}
                title={sendButton.label}
                aria-label={sendButton.label}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white transition-colors hover:bg-zinc-700 disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                {sendButton.icon}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
