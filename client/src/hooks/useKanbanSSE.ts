import { useEffect, useRef } from 'react';
import type { BoardEvent } from '@shared/types';

/** Generic hook that delivers every BoardEvent from SSE + BroadcastChannel cross-tab. */
export function useBoardEvents(onEvent: (event: BoardEvent) => void) {
  const sseRef = useRef<EventSource | null>(null);
  const bcRef = useRef<BroadcastChannel | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      es = new EventSource('/api/events');
      sseRef.current = es;

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as BoardEvent;
          onEventRef.current(event);
          // Forward to other tabs via BroadcastChannel (everything but kanban_changed
          // to avoid double-processing; kanban_changed IS forwarded so other tabs react)
          bcRef.current?.postMessage(event);
        } catch {}
      };

      es.onerror = () => {
        es?.close();
        reconnectTimer = setTimeout(connect, 3000);
      };
    }

    connect();

    // BroadcastChannel: receive events from OTHER tabs
    const bc = new BroadcastChannel('agentcontrol');
    bcRef.current = bc;
    bc.onmessage = (e) => {
      const event = e.data as BoardEvent;
      if (event.type) onEventRef.current(event);
    };

    return () => {
      es?.close();
      clearTimeout(reconnectTimer);
      bc.close();
      bcRef.current = null;
    };
  }, []);
}
