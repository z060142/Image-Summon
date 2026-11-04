import { contextBridge, ipcRenderer } from 'electron';

const call = async (channel: string, ...args: any[]) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

contextBridge.exposeInMainWorld('summon', {
  call,
  on: (channel: string, fn: () => void) => {
    const allowed = ['jobs:changed', 'settings:changed', 'clients:changed'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, () => fn());
  },
});
