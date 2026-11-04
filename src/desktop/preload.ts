import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent } from '../app/controller.js';
import { API_METHODS, EVENT_CHANNEL, apiChannel } from './ipc-contract.js';

const api: Record<string, unknown> = Object.fromEntries(API_METHODS.map((method) => [method, (arg?: unknown) => ipcRenderer.invoke(apiChannel(method), arg)]));

api.onEvent = (listener: (event: AppEvent) => void) => {
  const handler = (_event: unknown, payload: AppEvent) => listener(payload);
  ipcRenderer.on(EVENT_CHANNEL, handler);
  return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler);
};

contextBridge.exposeInMainWorld('airOrganizer', api);
