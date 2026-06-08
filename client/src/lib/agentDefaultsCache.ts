import { REASONING_EFFORTS, type AgentDefaults, type AgentModelGroup, type ReasoningEffort } from '@shared/types';

const AGENT_DEFAULTS_CACHE_KEY = 'agentcontrol.agentDefaults.v1';
const AGENT_MODEL_GROUPS_CACHE_KEY = 'agentcontrol.agentModelGroups.v1';
const TASK_AGENT_SETTINGS_CACHE_KEY = 'agentcontrol.taskAgentSettings.v1';
const TASK_AGENT_SETTINGS_CACHE_LIMIT = 100;

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isReasoningEffort(value: unknown): value is ReasoningEffort | null {
  return value === null || (
    typeof value === 'string' &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

function isAgentDefaults(value: unknown): value is AgentDefaults {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    isNullableString(record.provider) &&
    isNullableString(record.model) &&
    isNullableString(record.baseUrl) &&
    isNullableString(record.apiMode) &&
    isReasoningEffort(record.reasoningEffort) &&
    typeof record.showReasoning === 'boolean'
  );
}

export function readCachedAgentDefaults(): AgentDefaults | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(AGENT_DEFAULTS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isAgentDefaults(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCachedAgentDefaults(defaults: AgentDefaults): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AGENT_DEFAULTS_CACHE_KEY, JSON.stringify(defaults));
  } catch {
    // Defaults cache only improves first paint; failed writes should not block the app.
  }
}

// --- Model groups cache --------------------------------------------------
// The model picker list is identical across tasks and rarely changes, so we
// cache it once and seed the dropdown instantly while revalidating in the
// background.

function isAgentModelGroups(value: unknown): value is AgentModelGroup[] {
  if (!Array.isArray(value)) return false;
  return value.every((group) => {
    if (!group || typeof group !== 'object') return false;
    const record = group as Record<string, unknown>;
    return typeof record.provider === 'string' && Array.isArray(record.models);
  });
}

export function readCachedModelGroups(): AgentModelGroup[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(AGENT_MODEL_GROUPS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return isAgentModelGroups(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeCachedModelGroups(groups: AgentModelGroup[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AGENT_MODEL_GROUPS_CACHE_KEY, JSON.stringify(groups));
  } catch {
    // Cache only improves first paint; failed writes are non-fatal.
  }
}

// --- Per-task settings cache ---------------------------------------------
// Each task remembers its own model/provider/reasoning. Caching by taskId lets
// a re-opened task show the right model in the toolbar without waiting on the
// network round-trip.

export interface CachedTaskAgentSettings {
  model: string | null;
  provider: string | null;
  reasoningEffort: ReasoningEffort | null;
}

function isCachedTaskAgentSettings(value: unknown): value is CachedTaskAgentSettings {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    isNullableString(record.model) &&
    isNullableString(record.provider) &&
    isReasoningEffort(record.reasoningEffort)
  );
}

function readTaskSettingsMap(): Record<string, CachedTaskAgentSettings> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(TASK_AGENT_SETTINGS_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as Record<string, CachedTaskAgentSettings>;
  } catch {
    return {};
  }
}

export function readCachedTaskAgentSettings(taskId: string): CachedTaskAgentSettings | null {
  const map = readTaskSettingsMap();
  const entry = map[taskId];
  return isCachedTaskAgentSettings(entry) ? entry : null;
}

export function writeCachedTaskAgentSettings(taskId: string, settings: CachedTaskAgentSettings): void {
  if (typeof window === 'undefined') return;
  try {
    const map = readTaskSettingsMap();
    // Refresh insertion order (LRU) so we can cap the map size.
    delete map[taskId];
    map[taskId] = settings;
    const keys = Object.keys(map);
    if (keys.length > TASK_AGENT_SETTINGS_CACHE_LIMIT) {
      for (const stale of keys.slice(0, keys.length - TASK_AGENT_SETTINGS_CACHE_LIMIT)) {
        delete map[stale];
      }
    }
    window.localStorage.setItem(TASK_AGENT_SETTINGS_CACHE_KEY, JSON.stringify(map));
  } catch {
    // Cache only improves first paint; failed writes are non-fatal.
  }
}
