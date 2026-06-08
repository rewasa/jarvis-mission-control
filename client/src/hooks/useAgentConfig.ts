import { useState, useCallback, useEffect, useRef } from 'react';
import { fetchAgentDefaults, fetchAgentModels, fetchTaskAgentSettings } from '../lib/api';
import type { AgentRunSettings } from '../lib/api';
import {
  readCachedAgentDefaults,
  writeCachedAgentDefaults,
  readCachedModelGroups,
  writeCachedModelGroups,
  readCachedTaskAgentSettings,
  writeCachedTaskAgentSettings,
} from '../lib/agentDefaultsCache';
import type { AgentDefaults, AgentModelGroup, ReasoningEffort } from '@shared/types';

// In-memory caches survive task switches within a page session (instant, no
// localStorage round-trip). They are seeded from localStorage on first read so
// the model picker and toolbar also paint instantly after a full page reload.
let modelGroupsMemoryCache: AgentModelGroup[] | null = null;

function getCachedModelGroups(): AgentModelGroup[] {
  if (modelGroupsMemoryCache) return modelGroupsMemoryCache;
  const fromStorage = readCachedModelGroups();
  if (fromStorage.length > 0) modelGroupsMemoryCache = fromStorage;
  return modelGroupsMemoryCache ?? [];
}

export function useAgentConfig(taskId?: string, initialSettings?: AgentRunSettings) {
  const [defaults, setDefaults] = useState<AgentDefaults | null>(() => readCachedAgentDefaults());
  const [modelGroups, setModelGroups] = useState<AgentModelGroup[]>(() => getCachedModelGroups());

  // Seed the per-task model/provider/effort from cache so a re-opened task shows
  // the right model immediately instead of blanking the toolbar until the fetch
  // resolves.
  const cachedTaskSettings = taskId ? readCachedTaskAgentSettings(taskId) : null;
  const [model, setModel] = useState<string | null>(cachedTaskSettings?.model ?? initialSettings?.model ?? null);
  const [provider, setProvider] = useState<string | null>(cachedTaskSettings?.provider ?? initialSettings?.provider ?? null);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | null>(
    cachedTaskSettings?.reasoningEffort ?? initialSettings?.reasoningEffort ?? null,
  );

  // Only show a hard loading state when we have nothing cached to render. With
  // cached defaults + models (and, for a task, cached task settings) the toolbar
  // paints instantly and revalidates silently in the background.
  const hasEverythingCached =
    !!readCachedAgentDefaults() &&
    getCachedModelGroups().length > 0 &&
    (!taskId || cachedTaskSettings !== null);
  const [isLoading, setIsLoading] = useState(!hasEverythingCached);
  const initialRef = useRef(initialSettings);

  useEffect(() => {
    let cancelled = false;

    // BroadcastChannel for instant Safari cross-tab sync of Defaults
    const channel = new BroadcastChannel('agentcontrol.agentDefaults.v1');
    channel.onmessage = (e) => {
      try {
        setDefaults(e.data);
      } catch {}
    };

    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'agentcontrol.agentDefaults.v1' && e.newValue) {
        try {
          const newDefaults = JSON.parse(e.newValue);
          setDefaults(newDefaults);
        } catch {}
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => {
      channel.close();
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    Promise.allSettled([
      taskId ? fetchTaskAgentSettings(taskId) : fetchAgentDefaults(),
      fetchAgentModels(),
    ]).then(([settingsResult, modelsResult]) => {
      if (cancelled) return;
      if (settingsResult.status === 'fulfilled') {
        const val = settingsResult.value;
        if ('task' in val) {
          writeCachedAgentDefaults(val.defaults);
          setDefaults(val.defaults);
          const resolvedModel = val.task.model ?? initialRef.current?.model ?? null;
          const resolvedProvider = val.task.provider ?? initialRef.current?.provider ?? null;
          const resolvedEffort = val.task.reasoningEffort ?? initialRef.current?.reasoningEffort ?? null;
          setModel(resolvedModel);
          setProvider(resolvedProvider);
          setReasoningEffort(resolvedEffort);
          if (taskId) {
            writeCachedTaskAgentSettings(taskId, {
              model: val.task.model ?? null,
              provider: val.task.provider ?? null,
              reasoningEffort: val.task.reasoningEffort ?? null,
            });
          }
        } else {
          writeCachedAgentDefaults(val);
          setDefaults(val);
        }
      }
      if (modelsResult.status === 'fulfilled') {
        modelGroupsMemoryCache = modelsResult.value.groups;
        writeCachedModelGroups(modelsResult.value.groups);
        setModelGroups(modelsResult.value.groups);
      }
    }).finally(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, [taskId]);

  const replaceDefaults = useCallback((d: AgentDefaults) => {
    writeCachedAgentDefaults(d);
    setDefaults(d);
    try {
      new BroadcastChannel('agentcontrol.agentDefaults.v1').postMessage(d);
    } catch {}
  }, []);

  return { defaults, modelGroups, model, setModel, provider, setProvider, reasoningEffort, setReasoningEffort, isLoading, replaceDefaults };
}
