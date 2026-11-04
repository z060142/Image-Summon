import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { decryptSecret, encryptSecret, maskSecret, Mode, secretStorageMode, settings } from './config';
import { thumbnailDataUrl } from './images';
import {
  claudeCodeCommand, claudeCodeStatus, claudeDesktopStatus, desktopEntry, installClaudeCode, installClaudeDesktop,
  uninstallClaudeCode, uninstallClaudeDesktop,
} from './integrations';
import { currentCapabilities, jobs, publicJob } from './jobs';
import { SERVER_NAME } from './mcp';
import { cancelOpenRouterLogin, installOAuthRoute, startOpenRouterLogin } from './oauth';
import { codexStatus, detectCodex } from './providers/codex';
import { cacheAge, getCachedModels, keyInfo, refreshModels } from './providers/openrouter';
import { HttpHost } from './server';
import { MODE_LABEL } from './spec';

const RUN_KEY_NAME = 'ImageSummon';
const VERSION = app.getVersion();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('org.harumiya.imagesummon');
  app.on('second-instance', () => openSettings());
  app.on('window-all-closed', () => { /* stay in tray */ });
  app.whenReady().then(boot);
}

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let host: HttpHost;
let serverError: string | null = null;
let quitting = false;

function asset(name: string) {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(app.getAppPath(), 'assets');
  return path.join(base, name);
}

async function boot() {
  const first = settings.isFirstRun;
  settings.load();
  if (first) settings.persist();
  applyAutoStart();

  host = new HttpHost({ version: VERSION });
  installOAuthRoute(host);
  await startServer();

  createTray();
  registerIpc();

  jobs.on('changed', () => { updateTray(); send('jobs:changed'); });
  jobs.on('progress', () => send('jobs:changed'));
  jobs.on('finished', (j) => {
    if (j.status === 'error' && Notification.isSupported()) {
      new Notification({ title: 'Image Summon 生成失敗', body: String(j.error).slice(0, 200), icon: asset('icon.png') }).show();
    }
  });
  host.on('clients', () => send('clients:changed'));

  settings.on('changed', async (s, prev) => {
    if (s.general.port !== prev.general.port) await startServer();
    if (s.general.autoStart !== prev.general.autoStart) applyAutoStart();
    if (s.mode !== prev.mode || s.openrouter.model !== prev.openrouter.model || JSON.stringify(s.custom) !== JSON.stringify(prev.custom)
      || JSON.stringify(s.openrouter.defaults) !== JSON.stringify(prev.openrouter.defaults) || s.openrouter.keyEnc !== prev.openrouter.keyEnc
      || s.codex.model !== prev.codex.model) {
      host.broadcastToolsChanged();
    }
    updateTray();
    send('settings:changed');
  });

  // keep the OpenRouter model catalogue fresh (needed for the dynamic tool schema)
  if (cacheAge() > 12 * 3600_000) refreshModels().then(() => host.broadcastToolsChanged()).catch(() => {});

  const hidden = process.argv.includes('--hidden');
  if (first || !hidden) openSettings();
}

async function startServer() {
  const port = settings.get().general.port;
  try {
    await host.start(port);
    serverError = null;
  } catch (e: any) {
    serverError = e?.code === 'EADDRINUSE' ? `連接埠 ${port} 已被使用，請在設定頁更換` : String(e?.message ?? e);
    if (Notification.isSupported()) new Notification({ title: 'Image Summon 伺服器無法啟動', body: serverError }).show();
  }
  updateTray();
}

function applyAutoStart() {
  if (!app.isPackaged) return; // don't register the dev electron.exe
  app.setLoginItemSettings({
    openAtLogin: settings.get().general.autoStart,
    path: process.execPath,
    args: ['--hidden'],
    name: RUN_KEY_NAME,
  } as any);
}

// ---------------- tray ----------------

function createTray() {
  tray = new Tray(nativeImage.createFromPath(asset('tray-idle.png')));
  tray.on('click', () => openSettings());
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const s = settings.get();
  const caps = currentCapabilities();
  const active = jobs.activeCount;
  tray.setImage(nativeImage.createFromPath(asset(active ? 'tray-busy.png' : 'tray-idle.png')));
  const status = serverError ? `⚠ ${serverError}` : `● ${host.mcpUrl}`;
  tray.setToolTip(`Image Summon\n${MODE_LABEL[s.mode]} · ${caps.model}${active ? `\n生成中：${active}` : ''}`.slice(0, 127));
  const setMode = (m: Mode) => settings.update({ mode: m });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Image Summon ${VERSION}`, enabled: false },
    { label: status, enabled: false },
    { label: `${caps.ready ? '✓' : '✗'} ${caps.provider} · ${caps.model}`.slice(0, 80), enabled: false },
    ...(active ? [{ label: `生成中：${active} 個工作`, enabled: false }] : []),
    { type: 'separator' },
    { label: '開啟設定…', click: () => openSettings() },
    { label: '開啟輸出資料夾', click: () => { fs.mkdirSync(s.general.outputDir, { recursive: true }); shell.openPath(s.general.outputDir); } },
    {
      label: '生成方式',
      submenu: (['codex', 'openrouter', 'custom'] as Mode[]).map((m) => ({
        label: MODE_LABEL[m], type: 'radio' as const, checked: s.mode === m, click: () => setMode(m),
      })),
    },
    { label: '開機時自動啟動', type: 'checkbox', checked: s.general.autoStart, enabled: app.isPackaged, click: (i) => settings.update({ general: { autoStart: i.checked } }) },
    { type: 'separator' },
    { label: '結束 Image Summon', click: () => quit() },
  ]));
}

async function quit() {
  quitting = true;
  for (const j of jobs.list()) jobs.cancel(j.id);
  try { await host.stop(); } catch { /* ignore */ }
  tray?.destroy();
  app.exit(0);
}

// ---------------- settings window ----------------

function openSettings() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 820,
    minHeight: 600,
    title: 'Image Summon 設定',
    icon: asset('icon.png'),
    backgroundColor: '#101218',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(app.getAppPath(), 'renderer', 'index.html'));
  win.once('ready-to-show', () => win?.show());
  const cap = process.argv.find((a) => a.startsWith('--capture='));
  if (cap && !app.isPackaged) devCapture(win, cap.slice('--capture='.length));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win?.hide(); }
  });
}

/** Dev only: screenshot every settings page into a directory (used to check the UI). */
function devCapture(w: BrowserWindow, dir: string) {
  w.webContents.once('did-finish-load', async () => {
    fs.mkdirSync(dir, { recursive: true });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await wait(2500);
    for (const mode of ['codex', 'openrouter', 'custom']) {
      // render the panel locally without persisting the mode
      await w.webContents.executeJavaScript(`document.querySelector('.nav[data-page=gen]').click(); S.mode='${mode}'; renderMode();`);
      await wait(3000);
      fs.writeFileSync(path.join(dir, `gen-${mode}.png`), (await w.webContents.capturePage()).toPNG());
      await w.webContents.executeJavaScript(`document.querySelector('main').scrollTop = 700`);
      await wait(400);
      fs.writeFileSync(path.join(dir, `gen-${mode}-2.png`), (await w.webContents.capturePage()).toPNG());
      await w.webContents.executeJavaScript(`document.querySelector('main').scrollTop = 0`);
    }
    for (const page of ['agents', 'history', 'general']) {
      await w.webContents.executeJavaScript(`document.querySelector('.nav[data-page=${page}]').click()`);
      await wait(2500);
      fs.writeFileSync(path.join(dir, `${page}.png`), (await w.webContents.capturePage()).toPNG());
    }
    // finally simulate the user picking the OpenRouter card (real save → agents get tools/list_changed)
    await w.webContents.executeJavaScript(`document.querySelector('.nav[data-page=gen]').click(); document.querySelector('.mode[data-mode=openrouter]').click()`);
  });
}

function send(channel: string) {
  if (win && !win.isDestroyed()) win.webContents.send(channel);
}

// ---------------- IPC ----------------

function viewSettings() {
  const s = settings.get();
  const orKey = decryptSecret(s.openrouter.keyEnc);
  const cuKey = decryptSecret(s.custom.keyEnc);
  const { keyEnc: _a, ...openrouter } = s.openrouter;
  const { keyEnc: _b, ...custom } = s.custom;
  return {
    ...s,
    openrouter: { ...openrouter, hasKey: !!orKey, keyMasked: maskSecret(orKey) },
    custom: { ...custom, hasKey: !!cuKey, keyMasked: maskSecret(cuKey) },
  };
}

function registerIpc() {
  const h = (ch: string, fn: (...a: any[]) => any) => ipcMain.handle(ch, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
  });

  h('app:info', () => ({
    version: VERSION,
    url: host.mcpUrl,
    serverError,
    packaged: app.isPackaged,
    secretStorage: secretStorageMode(),
    claudeCodeCommand: claudeCodeCommand(host.mcpUrl),
    desktopJson: JSON.stringify({ mcpServers: { [SERVER_NAME]: desktopEntry(host.mcpUrl) } }, null, 2),
    clients: host.clients(),
  }));
  h('settings:get', () => viewSettings());
  h('settings:save', (patch: any) => {
    const p = { ...patch };
    // secrets arrive in plain text from the form; encrypt them here
    if (p.openrouter && typeof p.openrouter.apiKey === 'string') {
      const k = p.openrouter.apiKey.trim();
      p.openrouter = { ...p.openrouter, keyEnc: k ? encryptSecret(k) : '', keySource: k ? 'manual' : undefined };
    }
    if (p.openrouter) delete p.openrouter.apiKey;
    if (p.custom && typeof p.custom.apiKey === 'string') {
      p.custom = { ...p.custom, keyEnc: encryptSecret(p.custom.apiKey.trim()) };
    }
    if (p.custom) delete p.custom.apiKey;
    if (p.general?.port !== undefined) {
      const port = Number(p.general.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('連接埠必須介於 1024-65535');
      p.general.port = port;
    }
    settings.update(p);
    return viewSettings();
  });
  h('capabilities:get', () => currentCapabilities());

  h('openrouter:login', async () => {
    const r = await startOpenRouterLogin(host.port);
    if (!r.ok) throw new Error(r.error ?? '登入失敗');
    win?.show(); win?.focus();
    return viewSettings();
  });
  h('openrouter:cancelLogin', () => cancelOpenRouterLogin());
  h('openrouter:logout', () => { settings.update({ openrouter: { keyEnc: '', keySource: undefined } }); return viewSettings(); });
  h('openrouter:models', async (refresh: boolean) => {
    const models = refresh || !getCachedModels().length ? await refreshModels() : getCachedModels();
    if (refresh) host.broadcastToolsChanged();
    return models;
  });
  h('openrouter:keyInfo', () => keyInfo());

  h('codex:status', () => codexStatus());
  h('codex:detect', () => detectCodex());

  h('integrations:status', async () => ({
    desktop: claudeDesktopStatus(host.mcpUrl),
    code: await claudeCodeStatus(host.mcpUrl),
  }));
  h('integrations:install', async (target: 'desktop' | 'code') =>
    target === 'desktop' ? installClaudeDesktop(host.mcpUrl) : installClaudeCode(host.mcpUrl));
  h('integrations:uninstall', async (target: 'desktop' | 'code') =>
    target === 'desktop' ? uninstallClaudeDesktop() : uninstallClaudeCode());

  h('jobs:list', () => jobs.list().slice(0, 50).map((j) => ({
    ...publicJob(j),
    prompt: j.prompt,
    client: j.client,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt,
    params: j.params,
    errorDetail: j.errorDetail,
    thumbs: j.images.map((i) => thumbnailDataUrl(i.path)),
  })));
  h('jobs:cancel', (id: string) => jobs.cancel(id));
  h('jobs:test', (args: any) => {
    const j = jobs.submit(args, 'Image Summon 設定頁');
    return j.id;
  });

  h('shell:openPath', (p: string) => shell.openPath(p));
  h('shell:showItem', (p: string) => shell.showItemInFolder(p));
  h('shell:openExternal', (u: string) => { if (/^https:\/\//.test(u)) shell.openExternal(u); });
  h('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('dialog:pickFile', async (filters?: any) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters });
    return r.canceled ? null : r.filePaths[0];
  });
  h('dialog:pickImages', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    return r.canceled ? [] : r.filePaths;
  });
}
