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
  if (b.dataset.page === 'skills') loadSkillPage();
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
  for (const c of info.clients) cl.append(h('div', {}, `• ${c.client}`, h('span', { class: 'muted small' }, `  MCP ${c.protocol || ''} · 最後活動 ${new Date(c.lastSeen).toLocaleTimeString()}`)));
}

async function loadIntegrations() {
  await loadInfo();
  loadSkills();
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

// ---------------- skills (MCP Skills extension) ----------------
const SKILL_TEMPLATES = {
  style: {
    name: 'house-style',
    description: '我們的插畫/視覺風格指南。生成任何要給我們專案使用的插畫、橫幅、圖示或社群圖片時使用。',
    body: `# 視覺風格指南

## 整體風格
- 媒材：扁平向量插畫，柔和的漸層，圓角造型
- 氛圍：明亮、友善、專業

## 色彩
- 主色：#7C6CF6（紫）
- 輔色：#2EA8F5（藍）、#3CCF8E（綠）
- 背景：淺色、留白多

## 構圖
- 主體置中，四周保留至少 10% 留白
- 不要文字，除非使用者明確要求

## 避免
- 寫實照片風格、過度陰影、霓虹色、雜亂背景

## 範例提示詞
> Flat vector illustration of a friendly robot holding a lightbulb, soft purple (#7C6CF6) and blue (#2EA8F5) gradients, rounded shapes, light background, generous white space`,
  },
  logo: {
    name: 'company-logo',
    description: '公司 Logo 與品牌規範。當圖片需要放上公司 Logo、或要做品牌相關素材（橫幅、簡報封面、社群貼文）時使用。',
    body: `# 公司 Logo 使用規範

Logo 檔案附在本技能的 assets/ 中（見下方附加檔案清單）。需要 Logo 時，把它的本機路徑放進 generate_image 的 input_images，並在提示詞中說明要放在哪裡。

## 放置規則
- 預設放在右下角，寬度約為畫面寬度的 12–15%
- Logo 周圍保留至少 Logo 高度一半的淨空
- 不可變形、旋轉、改色或加特效
- 深色背景使用白色版本（若有附上）

## 品牌色
- 主色：#______
- 輔色：#______

## 提示詞寫法
> ...place the attached company logo unchanged in the bottom-right corner, about 12% of the image width, with clear space around it.`,
  },
  character: {
    name: 'mascot',
    description: '吉祥物/角色設定。生成包含我們吉祥物的任何圖片時使用，確保外觀一致。',
    body: `# 角色設定：（角色名稱）

## 外觀
- 物種/造型：
- 主要顏色：
- 服裝與配件：
- 表情特徵：

## 一定要保持一致的細節
-

## 參考圖
附加檔案中的參考圖是角色的標準外觀，生成時請放進 input_images 並說明「保持角色外觀與參考圖一致」。

## 避免
- 改變角色的配色或比例`,
  },
};

let skState = { current: null, originalName: null, readonly: false };

function renderSkills(r) {
  $('#sk-dir').textContent = r.dir;
  const st = `${r.skills.length} 個技能` + (r.warnings.length ? `・${r.warnings.length} 個警告` : '');
  for (const id of ['#sk-state', '#sk-pub-state']) {
    $(id).className = 'chip ' + (r.warnings.length ? 'warn' : 'ok');
    $(id).textContent = st;
  }
  const list = $('#sk-list');
  list.innerHTML = '';
  for (const s of r.skills) {
    list.append(h('div', {}, `${s.builtin ? '★' : '•'} `, h('b', {}, s.name), h('span', { class: 'muted' }, `  ${s.uri}（${s.files} 個檔案）`)));
  }
  $('#sk-warn').textContent = r.warnings.map((w) => `⚠ ${w.path}: ${w.message}`).join('\n');
}
async function loadSkills() {
  try { renderSkills(await api('skills:list')); } catch (e) { toast(e.message, true); }
}

async function loadSkillPage(select) {
  const [pub, mine] = await Promise.all([api('skills:list'), api('skills:userList')]);
  renderSkills(pub);
  $('#sk-count').textContent = `${mine.length} 個自訂`;
  const box = $('#sk-items');
  box.innerHTML = '';
  const builtin = pub.skills.find((s) => s.builtin);
  if (builtin) {
    box.append(h('div', { class: 'sk-item' + (skState.readonly ? ' sel' : ''), onclick: () => openBuiltin(builtin) },
      h('div', { class: 'sk-item-name' }, '★ ', builtin.name, h('span', { class: 'tag' }, '內建')),
      h('div', { class: 'sk-item-desc' }, builtin.description)));
  }
  for (const s of mine) {
    box.append(h('div', { class: 'sk-item' + (skState.originalName === s.name ? ' sel' : ''), onclick: () => openSkill(s.name) },
      h('div', { class: 'sk-item-name' }, s.name, s.files ? h('span', { class: 'tag' }, `${s.files} 個檔案`) : null),
      h('div', { class: 'sk-item-desc' }, s.description)));
  }
  if (!mine.length) box.append(h('div', { class: 'muted small' }, '還沒有自訂技能。'));
  if (select) await openSkill(select);
}

function showForm(on) {
  $('#sk-form').hidden = !on;
  $('#sk-empty').hidden = on;
}

function renderSkillFiles(files) {
  const box = $('#sk-files');
  box.innerHTML = '';
  if (!files.length) box.append(h('div', { class: 'muted small' }, '沒有附加檔案。'));
  for (const f of files) {
    box.append(h('div', { class: 'sk-file', title: f.abs },
      f.thumb ? h('img', { src: f.thumb, onclick: () => api('shell:openPath', f.abs) }) : h('div', { class: 'sk-file-ph' }, '📄'),
      h('div', { class: 'sk-file-name' }, f.path),
      h('div', { class: 'small muted' }, `${(f.bytes / 1024).toFixed(f.bytes < 10240 ? 1 : 0)} KB`),
      skState.readonly ? null : h('a', { class: 'danger', onclick: () => guard(null, async () => {
        if (!confirm(`刪除 ${f.path}？`)) return;
        const d = await api('skills:removeFile', skState.originalName, f.path);
        renderSkillFiles(d.files);
        loadSkillPage();
      }) }, '移除')));
  }
}

function fillForm(d, { readonly = false, isNew = false } = {}) {
  skState = { current: d, originalName: isNew ? null : d.name, readonly };
  showForm(true);
  $('#sk-title').textContent = readonly ? '內建技能' : isNew ? '新增技能' : '編輯技能';
  $('#sk-badge').textContent = readonly ? '唯讀' : isNew ? '尚未儲存' : `skill://${d.name}/SKILL.md`;
  $('#sk-badge').className = 'chip' + (readonly ? '' : isNew ? ' warn' : ' ok');
  $('#sk-name').value = d.name;
  $('#sk-desc').value = d.description;
  $('#sk-body').value = d.body;
  for (const id of ['#sk-name', '#sk-desc', '#sk-body']) $(id).readOnly = readonly;
  $('#sk-readonly').hidden = !readonly;
  $('#sk-readonly').textContent = readonly ? '內建技能會隨 Image Summon 更新，無法編輯；它的 references/generator.md 會跟著目前的生成器自動更新。' : '';
  for (const id of ['#sk-delete', '#sk-open-one', '#sk-save', '#sk-cancel']) $(id).hidden = readonly;
  $('#sk-delete').hidden = readonly || isNew;
  $('#sk-open-one').hidden = readonly || isNew;
  $('#sk-add-files').hidden = readonly;
  $('#sk-add-files').disabled = isNew;
  $('#sk-files-hint').textContent = isNew ? '先儲存技能，才能加入檔案。' : '';
  renderSkillFiles(d.files || []);
}

async function openSkill(name) {
  await guard(null, async () => { fillForm(await api('skills:get', name)); loadSkillPage(); });
}
function openBuiltin(b) {
  fillForm({ name: b.name, description: b.description, body: '（內建技能的完整內容由 Image Summon 提供，agent 透過 skill://image-summon/SKILL.md 讀取。）', files: [] }, { readonly: true });
  loadSkillPage();
}
function newSkill(tpl) {
  const t = tpl ? SKILL_TEMPLATES[tpl] : { name: '', description: '', body: '' };
  fillForm({ ...t, files: [] }, { isNew: true });
  loadSkillPage(); // clear the list selection
  $('#sk-name').focus();
}

$('#sk-new').onclick = () => newSkill();
$$('[data-template]').forEach((b) => (b.onclick = () => newSkill(b.dataset.template)));
$('#sk-name').addEventListener('input', (e) => {
  // gently normalise to the allowed form while typing
  const v = e.target.value.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (v !== e.target.value) e.target.value = v;
});
$('#sk-save').onclick = (e) => guard(e.target, async () => {
  const d = await api('skills:save', {
    originalName: skState.originalName || undefined,
    name: $('#sk-name').value.trim().replace(/^-+|-+$/g, ''),
    description: $('#sk-desc').value,
    body: $('#sk-body').value,
  });
  fillForm(d);
  await loadSkillPage();
  toast('已儲存，已通知連線中的 agent');
});
$('#sk-cancel').onclick = () => {
  if (skState.originalName) openSkill(skState.originalName);
  else { skState = { current: null, originalName: null, readonly: false }; showForm(false); }
};
$('#sk-delete').onclick = (e) => guard(e.target, async () => {
  if (!confirm(`確定要刪除技能「${skState.originalName}」和它的所有附加檔案嗎？`)) return;
  await api('skills:delete', skState.originalName);
  skState = { current: null, originalName: null, readonly: false };
  showForm(false);
  await loadSkillPage();
  toast('已刪除技能');
});
$('#sk-add-files').onclick = (e) => guard(e.target, async () => {
  const d = await api('skills:addFiles', skState.originalName);
  renderSkillFiles(d.files);
  loadSkillPage();
});
$('#sk-open-one').onclick = () => api('skills:openSkillDir', skState.originalName);
$('#sk-open').onclick = () => api('skills:openDir');
$('#sk-reload').onclick = (e) => guard(e.target, async () => { await api('skills:reload'); await loadSkillPage(); toast('已重新載入技能，已通知連線中的 agent'); });
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) $(`.nav[data-page="${g.dataset.goto}"]`).click();
});

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
