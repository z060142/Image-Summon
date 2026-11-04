/* global summon */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const api = (ch, ...a) => window.summon.call(ch, ...a);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), err ? 6000 : 3000);
}

async function guard(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message || String(e), true); } finally { if (btn) btn.disabled = false; }
}

const MODE_LABEL = { codex: 'Codex CLI 轉發', openrouter: 'OpenRouter', custom: '自訂 API' };
const RES_PRESETS = ['512', '1K', '2K', '4K'];
const AR_PRESETS = ['1:1', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '16:9', '9:16', '21:9', '9:21', 'auto'];
const Q_PRESETS = ['auto', 'low', 'medium', 'high'];
const FORMAT_BASE = {
  'openai-images': 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  'openrouter-images': 'https://openrouter.ai/api/v1',
  'openai-chat': 'https://openrouter.ai/api/v1',
};

let S = null; // settings view
let models = [];
let selectedModel = '';
let info = null;

// ---------------- navigation ----------------
$$('.nav').forEach((b) => b.addEventListener('click', () => {
  $$('.nav').forEach((x) => x.classList.toggle('active', x === b));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + b.dataset.page));
  if (b.dataset.page === 'agents') loadIntegrations();
  if (b.dataset.page === 'history') loadJobs();
}));

document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-copy]');
  if (!c) return;
  navigator.clipboard.writeText($(c.dataset.copy).textContent).then(() => toast('已複製'));
});

// ---------------- mode cards ----------------
$$('.mode').forEach((b) => b.addEventListener('click', () => guard(null, async () => {
  if (S.mode === b.dataset.mode) return;
  S = await api('settings:save', { mode: b.dataset.mode });
  renderMode();
  toast(`已切換為「${MODE_LABEL[S.mode]}」，已通知連線中的 agent`);
})));

function renderMode() {
  $$('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === S.mode));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === S.mode));
  if (S.mode === 'codex') checkCodex();
  if (S.mode === 'openrouter') { renderOrAccount(); if (!models.length) loadModels(false); }
  renderCaps();
}

// ---------------- Codex ----------------
async function checkCodex() {
  $('#codex-status').textContent = '檢查中…';
  try {
    const st = await api('codex:status');
    if (!st.found) {
      $('#codex-status').innerHTML = '';
      $('#codex-status').append(h('span', { class: 'chip err' }, '找不到 codex'), '  請安裝 Codex CLI，或在下方指定 codex.exe 路徑。');
      return;
    }
    $('#codex-status').innerHTML = '';
    $('#codex-status').append(
      h('span', { class: 'chip ' + (st.ok ? 'ok' : 'warn') }, st.ok ? '已登入' : '未登入'), '  ',
      `${st.version}\n路徑：${st.path}\n${st.login}`,
    );
  } catch (e) { $('#codex-status').textContent = e.message; }
}
$('#codex-check').onclick = checkCodex;
$('#codex-browse').onclick = () => guard(null, async () => {
  const p = await api('dialog:pickFile', [{ name: 'codex', extensions: ['exe', 'cmd'] }]);
  if (p) $('#codex-path').value = p;
});
$('#codex-save').onclick = (e) => guard(e.target, async () => {
  S = await api('settings:save', { codex: {
    path: $('#codex-path').value.trim(), model: $('#codex-model').value.trim(),
    timeoutSec: Math.max(30, Number($('#codex-timeout').value) || 600), extraArgs: $('#codex-extra').value.trim(),
  } });
  toast('Codex 設定已儲存'); checkCodex(); renderCaps();
});

// ---------------- OpenRouter ----------------
function renderOrAccount() {
  const st = $('#or-key-state');
  st.className = 'chip ' + (S.openrouter.hasKey ? 'ok' : 'warn');
  st.textContent = S.openrouter.hasKey ? `已連結 ${S.openrouter.keyMasked}${S.openrouter.keySource === 'oauth' ? '（OAuth）' : '（手動）'}` : '未登入';
  $('#or-key-info').textContent = '';
  if (S.openrouter.hasKey) {
    api('openrouter:keyInfo').then((k) => {
      const parts = [];
      if (k.label) parts.push(k.label);
      if (k.usage !== undefined) parts.push(`已用 $${Number(k.usage).toFixed(3)}`);
      if (k.limit != null) parts.push(`上限 $${k.limit}`);
      if (k.limit_remaining != null) parts.push(`剩餘 $${Number(k.limit_remaining).toFixed(3)}`);
      $('#or-key-info').textContent = parts.join(' · ');
    }).catch((e) => { $('#or-key-info').textContent = '金鑰檢查失敗：' + e.message; });
  }
}
$('#or-login').onclick = (e) => guard(e.target, async () => {
  $('#or-cancel').hidden = false;
  toast('已開啟瀏覽器，請在 OpenRouter 授權…');
  try {
    S = await api('openrouter:login');
    toast('OpenRouter 登入成功');
    renderOrAccount(); renderCaps();
  } finally { $('#or-cancel').hidden = true; }
});
$('#or-cancel').onclick = () => api('openrouter:cancelLogin');
$('#or-logout').onclick = (e) => guard(e.target, async () => {
  if (!confirm('確定清除 OpenRouter 金鑰？（不會從 OpenRouter 刪除金鑰本身）')) return;
  S = await api('openrouter:logout'); renderOrAccount(); renderCaps();
});
$('#or-manual-save').onclick = (e) => guard(e.target, async () => {
  const k = $('#or-manual-key').value.trim();
  if (!k) return toast('請輸入金鑰', true);
  S = await api('settings:save', { openrouter: { apiKey: k } });
  $('#or-manual-key').value = '';
  toast('金鑰已儲存'); renderOrAccount(); renderCaps();
});

async function loadModels(refresh) {
  $('#or-models').innerHTML = '<div class="model muted">載入中…</div>';
  try {
    models = await api('openrouter:models', refresh);
    renderModels();
    renderOrDefaults();
    if (refresh) toast(`已更新：${models.length} 個生圖模型`);
  } catch (e) {
    $('#or-models').innerHTML = '';
    $('#or-models').append(h('div', { class: 'model' }, '無法取得模型清單：' + e.message));
  }
}
$('#or-refresh').onclick = (e) => guard(e.target, () => loadModels(true));
$('#or-filter').oninput = () => renderModels();

function paramTags(sp) {
  const tags = [];
  const en = (k) => (sp[k] && sp[k].type === 'enum' ? sp[k].values : null);
  if (en('resolution')) tags.push(en('resolution').join('/'));
  if (en('aspect_ratio')) tags.push(`${en('aspect_ratio').filter((x) => x !== 'auto').length} 種比例`);
  if (en('quality')) tags.push('品質 ' + en('quality').join('/'));
  if (sp.n && sp.n.max > 1) tags.push(`最多 ${sp.n.max} 張`);
  if (sp.input_references && sp.input_references.max > 0) tags.push(`參考圖 ≤${sp.input_references.max}`);
  if (en('background') && en('background').includes('transparent')) tags.push('透明背景');
  if (sp.seed) tags.push('seed');
  return tags;
}

function renderModels() {
  const q = $('#or-filter').value.trim().toLowerCase();
  const list = $('#or-models');
  list.innerHTML = '';
  const shown = models.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q));
  shown.sort((a, b) => (a.id === selectedModel ? -1 : b.id === selectedModel ? 1 : 0));
  for (const m of shown) {
    const row = h('div', { class: 'model' + (m.id === selectedModel ? ' sel' : ''), title: m.description || '' },
      h('div', { class: 'radio' }),
      h('div', {},
        h('div', { class: 'm-name' }, m.name || m.id),
        h('div', { class: 'm-id' }, m.id),
        h('div', { class: 'tags' }, paramTags(m.supported_parameters || {}).map((t) => h('span', { class: 'tag' }, t)))));
    row.onclick = () => guard(null, async () => {
      selectedModel = m.id;
      S = await api('settings:save', { openrouter: { model: m.id } });
      renderModels(); renderOrDefaults(); renderCaps();
      toast(`模型已切換為 ${m.name || m.id}`);
    });
    list.append(row);
  }
  if (!shown.length) list.append(h('div', { class: 'model muted' }, '沒有符合的模型'));
}

function fillSelect(sel, values, current, emptyLabel = '（不指定）') {
  sel.innerHTML = '';
  sel.append(h('option', { value: '' }, values.length ? emptyLabel : '（此模型不支援）'));
  for (const v of values) sel.append(h('option', { value: v, selected: v === current }, v));
  sel.disabled = !values.length;
}

function renderOrDefaults() {
  const m = models.find((x) => x.id === selectedModel);
  const sp = (m && m.supported_parameters) || {};
  const en = (k) => (sp[k] && sp[k].type === 'enum' ? sp[k].values : []);
  const d = S.openrouter.defaults || {};
  fillSelect($('#or-def-res'), en('resolution'), d.resolution);
  fillSelect($('#or-def-ar'), en('aspect_ratio'), d.aspect_ratio);
  fillSelect($('#or-def-q'), en('quality'), d.quality);
}
$('#or-save').onclick = (e) => guard(e.target, async () => {
  S = await api('settings:save', { openrouter: { defaults: {
    resolution: $('#or-def-res').value || undefined, aspect_ratio: $('#or-def-ar').value || undefined, quality: $('#or-def-q').value || undefined,
  } } });
  toast('預設參數已儲存'); renderCaps();
});

// ---------------- Custom ----------------
const cuState = { res: [], ar: [], q: [] };
function chipToggles(el, presets, key) {
  el.innerHTML = '';
  const all = [...new Set([...presets, ...cuState[key].filter((v) => !presets.includes(v) && key !== 'res')])];
  for (const v of all) {
    const b = h('button', { class: 'tog' + (cuState[key].includes(v) ? ' on' : ''), type: 'button' }, v);
    b.onclick = () => {
      cuState[key] = cuState[key].includes(v) ? cuState[key].filter((x) => x !== v) : [...cuState[key], v];
      b.classList.toggle('on');
      renderCuDefaults();
    };
    el.append(b);
  }
}
function cuResolutions() {
  const extra = $('#cu-res-extra').value.split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([...RES_PRESETS.filter((r) => cuState.res.includes(r)), ...extra])];
}
function renderCuDefaults() {
  const d = S.custom.defaults || {};
  fillSelect($('#cu-def-res'), cuResolutions(), $('#cu-def-res').value || d.resolution);
  fillSelect($('#cu-def-ar'), cuState.ar, $('#cu-def-ar').value || d.aspect_ratio);
  fillSelect($('#cu-def-q'), cuState.q, $('#cu-def-q').value || d.quality);
}
function renderCustom() {
  const c = S.custom;
  $('#cu-name').value = c.name || '';
  $('#cu-format').value = c.format;
  $('#cu-base').value = c.baseUrl || '';
  $('#cu-key').value = '';
  $('#cu-key').placeholder = c.hasKey ? `已儲存 ${c.keyMasked}（留空保持不變）` : '（選填）';
  $('#cu-model').value = c.model || '';
  cuState.res = [...c.resolutions];
  cuState.ar = [...c.aspectRatios];
  cuState.q = [...c.qualities];
  $('#cu-res-extra').value = c.resolutions.filter((r) => !RES_PRESETS.includes(r)).join(', ');
  chipToggles($('#cu-res'), RES_PRESETS, 'res');
  chipToggles($('#cu-ar'), AR_PRESETS, 'ar');
  chipToggles($('#cu-q'), [...Q_PRESETS, ...c.qualities.filter((x) => !Q_PRESETS.includes(x))], 'q');
  $('#cu-maxn').value = c.maxN;
  $('#cu-maxin').value = c.maxInputImages;
  $('#cu-xh').value = c.extraHeaders || '';
  $('#cu-xb').value = c.extraBody || '';
  $('#cu-def-res').value = ''; $('#cu-def-ar').value = ''; $('#cu-def-q').value = '';
  renderCuDefaults();
}
$('#cu-res-extra').oninput = renderCuDefaults;
$('#cu-format').onchange = () => {
  const cur = $('#cu-base').value.trim();
  if (!cur || Object.values(FORMAT_BASE).includes(cur)) $('#cu-base').value = FORMAT_BASE[$('#cu-format').value];
};
$('#cu-save').onclick = (e) => guard(e.target, async () => {
  for (const [id, label] of [['#cu-xh', 'Headers'], ['#cu-xb', 'Body']]) {
    const v = $(id).value.trim();
    if (v) { try { const o = JSON.parse(v); if (typeof o !== 'object' || Array.isArray(o)) throw 0; } catch { throw new Error(`額外 ${label} 必須是 JSON 物件`); } }
  }
  const patch = { custom: {
    name: $('#cu-name').value.trim(), format: $('#cu-format').value, baseUrl: $('#cu-base').value.trim(), model: $('#cu-model').value.trim(),
    resolutions: cuResolutions(), aspectRatios: [...cuState.ar], qualities: [...cuState.q],
    maxN: Math.max(1, Number($('#cu-maxn').value) || 1), maxInputImages: Math.max(0, Number($('#cu-maxin').value) || 0),
    extraHeaders: $('#cu-xh').value.trim(), extraBody: $('#cu-xb').value.trim(),
    defaults: { resolution: $('#cu-def-res').value || undefined, aspect_ratio: $('#cu-def-ar').value || undefined, quality: $('#cu-def-q').value || undefined },
  } };
  const key = $('#cu-key').value.trim();
  if (key) patch.custom.apiKey = key;
  S = await api('settings:save', patch);
  renderCustom(); renderCaps();
  toast('自訂供應商已儲存，已通知 agent 更新規格');
});

// ---------------- capabilities preview & test ----------------
async function renderCaps() {
  const c = await api('capabilities:get');
  const r = $('#caps-ready');
  r.className = 'chip ' + (c.ready ? 'ok' : 'err');
  r.textContent = c.ready ? '就緒' : '未就緒：' + c.notReadyReason;
  const box = $('#caps');
  box.innerHTML = '';
  const row = (k, vals, def) => {
    box.append(h('div', { class: 'k' }, k));
    box.append(h('div', { class: 'v' }, typeof vals === 'string' ? vals
      : vals.length ? vals.map((v) => h('span', { class: 'tag' + (v === def ? ' def' : '') }, v + (v === def ? ' ★' : ''))) : h('span', { class: 'muted' }, '不支援')));
  };
  row('模式', c.modeLabel);
  row('供應商 / 模型', `${c.provider} · ${c.model}`);
  if (c.mode === 'codex') {
    row('參數', 'prompt、input_images（參考圖）、n、output_path。尺寸與比例由 Codex 決定，可在提示詞中描述。');
  } else {
    row('resolution', c.resolutions, c.defaults.resolution);
    row('aspect_ratio', c.aspectRatios, c.defaults.aspect_ratio);
    row('quality', c.qualities, c.defaults.quality);
    if (c.backgrounds.length) row('background', c.backgrounds);
    if (c.outputFormats.length) row('output_format', c.outputFormats);
    row('n（張數）', `1 – ${c.maxN}`);
    row('input_images', c.maxInputImages ? `最多 ${c.maxInputImages} 張` : '不支援');
  }
  // test options
  const opts = $('#test-opts');
  opts.innerHTML = '';
  const mk = (id, label, vals, def) => {
    if (!vals.length) return;
    const s = h('select', { id }, h('option', { value: '' }, `${label}：預設${def ? `（${def}）` : ''}`), vals.map((v) => h('option', { value: v }, `${label}：${v}`)));
    s.style.width = 'auto';
    opts.append(s);
  };
  mk('t-res', '解析度', c.resolutions, c.defaults.resolution);
  mk('t-ar', '比例', c.aspectRatios, c.defaults.aspect_ratio);
  mk('t-q', '品質', c.qualities, c.defaults.quality);
}

$('#test-run').onclick = (e) => guard(e.target, async () => {
  const prompt = $('#test-prompt').value.trim();
  if (!prompt) return toast('請輸入提示詞', true);
  const args = { prompt };
  const v = (id) => ($(id) ? $(id).value : '');
  if (v('#t-res')) args.resolution = v('#t-res');
  if (v('#t-ar')) args.aspect_ratio = v('#t-ar');
  if (v('#t-q')) args.quality = v('#t-q');
  await api('jobs:test', args);
  toast('已開始生成，請到「生成紀錄」查看');
});

// ---------------- integrations ----------------
async function loadInfo() {
  info = await api('app:info');
  $('#version').textContent = 'v' + info.version + (info.packaged ? '' : ' · dev');
  $('#mcp-url').textContent = info.url;
  $('#cc-cmd').textContent = info.claudeCodeCommand;
  if (info.secretStorage === 'memory') $('.secret-hint').forEach((el) => { el.textContent = '⚠ 此系統無法使用 Windows 加密儲存，金鑰只會保存在記憶體，結束 Image Summon 後需要重新登入 / 輸入。'; });
  $('#cd-json').textContent = info.desktopJson;
  const pill = $('#server-pill');
  pill.className = 'server-pill' + (info.serverError ? ' err' : '');
  pill.innerHTML = '';
  pill.append(h('span', { class: 'dot' }), info.serverError || info.url);
  const cl = $('#clients');
  cl.innerHTML = '';
  if (!info.clients.length) cl.textContent = '目前沒有連線';
  for (const c of info.clients) cl.append(h('div', {}, `• ${c.client}`, h('span', { class: 'muted small' }, `  最後活動 ${new Date(c.lastSeen).toLocaleTimeString()}`)));
}

async function loadIntegrations() {
  await loadInfo();
  $('#cc-state').textContent = '檢查中…';
  try {
    const st = await api('integrations:status');
    const cc = st.code;
    $('#cc-state').className = 'chip ' + (cc.upToDate ? 'ok' : cc.installed ? 'warn' : '');
    $('#cc-state').textContent = !cc.cli ? '找不到 claude CLI' : cc.upToDate ? '已註冊' : cc.installed ? '已註冊（網址不同，請重新註冊）' : '未註冊';
    const any = st.desktop.some((d) => d.installed);
    const ok = st.desktop.some((d) => d.upToDate);
    $('#cd-state').className = 'chip ' + (ok ? 'ok' : any ? 'warn' : '');
    $('#cd-state').textContent = ok ? '已註冊' : any ? '需要更新' : '未註冊';
    $('#cd-files').innerHTML = '';
    for (const d of st.desktop) $('#cd-files').append(h('div', {}, `${d.upToDate ? '✓' : d.installed ? '△' : '·'} ${d.file}${d.exists ? '' : '（尚不存在，將建立）'}`));
  } catch (e) { toast(e.message, true); }
}
$('#cc-install').onclick = (e) => guard(e.target, async () => { await api('integrations:install', 'code'); toast('已註冊到 Claude Code（新開的 session 會載入）'); loadIntegrations(); });
$('#cc-remove').onclick = (e) => guard(e.target, async () => { await api('integrations:uninstall', 'code'); toast('已從 Claude Code 移除'); loadIntegrations(); });
$('#cd-install').onclick = (e) => guard(e.target, async () => { await api('integrations:install', 'desktop'); toast('已寫入 Claude Desktop 設定，請重新啟動 Claude Desktop'); loadIntegrations(); });
$('#cd-remove').onclick = (e) => guard(e.target, async () => { await api('integrations:uninstall', 'desktop'); toast('已從 Claude Desktop 設定移除'); loadIntegrations(); });

// ---------------- jobs ----------------
const STATUS = { queued: '⏳ 排隊中', running: '⟳ 生成中', done: '✓ 完成', error: '✗ 失敗', cancelled: '⊘ 已取消' };
async function loadJobs() {
  const list = await api('jobs:list');
  const active = list.filter((j) => j.status === 'queued' || j.status === 'running').length;
  const b = $('#active-badge');
  b.hidden = !active; b.textContent = active;
  const box = $('#jobs');
  box.innerHTML = '';
  if (!list.length) { box.append(h('div', { class: 'card muted' }, '還沒有生成紀錄。')); return; }
  for (const j of list) {
    const thumbs = j.images.length
      ? j.images.map((img, i) => h('img', { src: j.thumbs[i] || '', title: img.path, onclick: () => api('shell:openPath', img.path) }))
      : [h('div', { class: 'ph' }, j.status === 'running' || j.status === 'queued' ? h('span', { class: 'spin' }, '⟳') : '—')];
    const p = j.params || {};
    const meta = [STATUS[j.status] + (j.status === 'running' ? ` · ${j.progress}` : ''), `${MODE_LABEL[j.mode] || j.mode} · ${j.model}`,
      [p.resolution, p.aspect_ratio, p.quality].filter(Boolean).join(' / '), j.client, new Date(j.createdAt).toLocaleString(),
      j.finishedAt ? `${Math.round((j.finishedAt - j.createdAt) / 1000)}s` : '', j.cost_usd !== undefined ? `$${j.cost_usd.toFixed(4)}` : '']
      .filter(Boolean).join(' · ');
    box.append(h('div', { class: 'job' },
      h('div', { class: 'thumbs' }, thumbs),
      h('div', { class: 'body' },
        h('div', { class: 'prompt', title: j.prompt }, j.prompt),
        h('div', { class: 'meta' }, meta),
        j.error ? h('div', { class: 'err' }, j.error + (j.errorDetail ? '\n' + j.errorDetail.slice(0, 1200) : '')) : null,
        h('div', { class: 'links' },
          j.images.map((img) => h('a', { onclick: () => api('shell:showItem', img.path) }, '在資料夾中顯示 ' + img.path.split(/[\\/]/).pop())),
          (j.status === 'running' || j.status === 'queued') ? h('a', { onclick: () => api('jobs:cancel', j.job_id) }, '取消') : null))));
  }
}
$('#open-out').onclick = () => api('shell:openPath', S.general.outputDir);
let jobsTimer;
window.summon.on('jobs:changed', () => { clearTimeout(jobsTimer); jobsTimer = setTimeout(loadJobs, 150); });
window.summon.on('clients:changed', () => loadInfo());
window.summon.on('settings:changed', async () => {
  const prevMode = S && S.mode;
  S = await api('settings:get');
  selectedModel = S.openrouter.model;
  if (S.mode !== prevMode) renderMode(); else renderCaps();
});

// ---------------- general ----------------
function renderGeneral() {
  const g = S.general;
  $('#g-out').value = g.outputDir;
  $('#g-port').value = g.port;
  $('#g-conc').value = g.maxConcurrent;
  $('#g-prev').value = g.previewMaxEdge;
  $('#g-auto').checked = g.autoStart;
  $('#g-auto').disabled = !info.packaged;
  $('#g-incprev').checked = g.includePreview;
}
$('#g-out-browse').onclick = () => guard(null, async () => { const p = await api('dialog:pickDir'); if (p) $('#g-out').value = p; });
$('#g-save').onclick = (e) => guard(e.target, async () => {
  const oldPort = S.general.port;
  S = await api('settings:save', { general: {
    outputDir: $('#g-out').value.trim(), port: Number($('#g-port').value), maxConcurrent: Math.max(1, Number($('#g-conc').value) || 1),
    previewMaxEdge: Math.max(256, Number($('#g-prev').value) || 1024), autoStart: $('#g-auto').checked, includePreview: $('#g-incprev').checked,
  } });
  await loadInfo();
  toast(S.general.port !== oldPort ? '已儲存；連接埠已變更，請重新註冊 Claude Code / Desktop' : '已儲存');
});

// ---------------- boot ----------------
(async function init() {
  try {
    [S] = await Promise.all([api('settings:get'), loadInfo()]);
    selectedModel = S.openrouter.model;
    $('#codex-path').value = S.codex.path;
    $('#codex-model').value = S.codex.model;
    $('#codex-timeout').value = S.codex.timeoutSec;
    $('#codex-extra').value = S.codex.extraArgs;
    renderCustom();
    renderGeneral();
    renderMode();
    loadJobs();
  } catch (e) { toast('初始化失敗：' + e.message, true); }
})();
