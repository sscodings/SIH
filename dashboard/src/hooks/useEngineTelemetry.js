import { useState, useEffect, useRef, useCallback } from 'react';

const WS_URL = 'ws://localhost:8000/ws/engine';
const RECONNECT_DELAY_MS = 2000;

export function useEngineTelemetry() {
  const [telemetry, setTelemetry] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastError, setLastError] = useState(null);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const isMountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!isMountedRef.current) return;

    try {
      const socket = new WebSocket(WS_URL);
      wsRef.current = socket;

      socket.onopen = () => {
        if (!isMountedRef.current) return;
        setIsConnected(true);
        setLastError(null);
        console.log('[useEngineTelemetry] WebSocket connected to', WS_URL);
      };

      socket.onmessage = (event) => {
        if (!isMountedRef.current) return;
        try {
          const data = JSON.parse(event.data);
          setTelemetry(data);
        } catch (err) {
          console.error('[useEngineTelemetry] JSON parse error:', err);
        }
      };

      socket.onerror = (event) => {
        if (!isMountedRef.current) return;
        console.warn('[useEngineTelemetry] WebSocket error:', event);
        setLastError('Connection error');
      };

      socket.onclose = (event) => {
        if (!isMountedRef.current) return;
        setIsConnected(false);
        console.log(`[useEngineTelemetry] WebSocket closed (code ${event.code}). Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      };
    } catch (err) {
      console.error('[useEngineTelemetry] Error creating WebSocket:', err);
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    connect();

    return () => {
      isMountedRef.current = false;
      clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  const sendCommand = useCallback((commandObject) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(commandObject));
      return true;
    } else {
      console.warn('[useEngineTelemetry] Cannot send command: socket is not open');
      return false;
    }
  }, []);

  return {
    telemetry,
    isConnected,
    lastError,
    sendCommand,
  };
}
