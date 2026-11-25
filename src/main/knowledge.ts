import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { thumbnailDataUrl } from './images';

/*
 * The user's image knowledge base: style guides, company logos, brand colours, mascot sheets…
 *
 * These are NOT separate skills. Each item is served as a sub-item of the built-in `image-summon`
 * skill (skill://image-summon/knowledge/<name>/README.md, attachments under …/assets/), and the
 * built-in SKILL.md carries an index of them. Agents see exactly one skill from Image Summon.
 *
 * On disk: %APPDATA%\image-summon\knowledge\<name>\README.md (+ assets/). README.md keeps a small
 * frontmatter (name, description) for the index; an auto-generated section lists every attachment
 * with its absolute local path so a local agent can pass e.g. a logo to generate_image input_images.
 */

export const ITEM_FILE = 'README.md';
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ATTACH_START = '<!-- image-summon:attachments:start (auto-generated, edit in Image Summon) -->';
const ATTACH_END = '<!-- image-summon:attachments:end -->';
const IMAGE_RE = /\.(png|jpe?g|webp|gif|svg)$/i;
/** Per file; everything together counts toward the skill's 16 MiB publication limit. */
const MAX_FILE = 8 * 1024 * 1024;

export interface KnowledgeFile { path: string; abs: string; bytes: number; image: boolean; thumb?: string }
export interface KnowledgeItem { name: string; description: string; body: string; files: KnowledgeFile[]; dir: string }
export interface KnowledgeSummary { name: string; description: string; files: string[]; dir: string }

export function knowledgeDir(): string {
  return path.join(app.getPath('userData'), 'knowledge');
}

function itemDir(name: string) {
  return path.join(knowledgeDir(), name);
}

function assertName(name: string) {
  if (!NAME_RE.test(name) || name.length > 64) {
    throw new Error('名稱只能使用小寫英文字母、數字和連字號（例如 brand-style），最多 64 個字元，且不能以連字號開頭或結尾');
  }
}

function assertExisting(name: string) {
  assertName(name);
  if (!fs.existsSync(path.join(itemDir(name), ITEM_FILE))) throw new Error(`找不到項目 ${name}`);
}

/** Resolve a path inside an item folder, refusing anything that escapes it. */
function inside(name: string, rel: string): string {
  const base = itemDir(name);
  const p = path.resolve(base, rel);
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('路徑不在項目資料夾內');
  return p;
}

function parseItem(text: string): { description: string; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { description: '', body: text.trim() };
  const line = /^description:\s*(.*)$/m.exec(m[1])?.[1]?.trim() ?? '';
  let description = line;
  if (line.startsWith('"')) { try { description = JSON.parse(line); } catch { /* keep raw */ } }
  else if (line.startsWith("'") && line.endsWith("'")) description = line.slice(1, -1).replace(/''/g, "'");
  let body = m[2];
  const a = body.indexOf(ATTACH_START);
  const b = body.indexOf(ATTACH_END);
  if (a >= 0 && b > a) body = body.slice(0, a) + body.slice(b + ATTACH_END.length);
  return { description, body: body.replace(/^\n+/, '').trimEnd() };
}

function walkFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    // SKILL.md is never served below the mount (it would look like a nested skill), so don't list it either
    if (e.name.startsWith('.') || e.name === 'SKILL.md') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(dir, r));
    else if (e.isFile() && r !== ITEM_FILE) out.push(r);
  }
  return out.sort();
}

export function localPath(name: string, rel: string): string {
  return path.join(itemDir(name), ...rel.split('/'));
}

function attachmentSection(name: string, files: string[]): string {
  if (!files.length) return '';
  const lines = [ATTACH_START, '', '## Attached files', ''];
  lines.push('Image files can be passed directly to `generate_image` in `input_images` using the local path');
  lines.push('(e.g. a logo to place in the image, or a style reference to match).', '');
  for (const f of files) lines.push(`- \`${f}\` — local path: \`${localPath(name, f)}\``);
  lines.push('', ATTACH_END);
  return lines.join('\n');
}

function writeItem(name: string, description: string, body: string) {
  const text = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`, // a JSON string is a valid YAML double-quoted scalar
    '---',
    '',
    body.trim() || `# ${name}`,
    '',
    attachmentSection(name, walkFiles(itemDir(name))),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  fs.writeFileSync(path.join(itemDir(name), ITEM_FILE), text, 'utf8');
}

/** All items, sorted by name. Pure filesystem read (used to build the skill index). */
export function listKnowledge(): KnowledgeSummary[] {
  const root = knowledgeDir();
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out: KnowledgeSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || !NAME_RE.test(e.name)) continue;
    const file = path.join(root, e.name, ITEM_FILE);
    if (!fs.existsSync(file)) continue;
    const p = parseItem(fs.readFileSync(file, 'utf8'));
    out.push({ name: e.name, description: p.description, files: walkFiles(path.join(root, e.name)), dir: path.join(root, e.name) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getItem(name: string): KnowledgeItem {
  assertExisting(name);
  const dir = itemDir(name);
  const p = parseItem(fs.readFileSync(path.join(dir, ITEM_FILE), 'utf8'));
  const files = walkFiles(dir).map((rel) => {
    const abs = localPath(name, rel);
    const image = IMAGE_RE.test(rel);
    return { path: rel, abs, bytes: fs.statSync(abs).size, image, thumb: image ? thumbnailDataUrl(abs, 120) : undefined };
  });
  return { name, description: p.description, body: p.body, files, dir };
}

export function saveItem(input: { originalName?: string; name: string; description: string; body: string }): KnowledgeItem {
  const name = String(input.name ?? '').trim();
  const description = String(input.description ?? '').trim().replace(/\s*\n\s*/g, ' ');
  assertName(name);
  if (!description) throw new Error('請填寫說明：agent 依這段文字判斷什麼時候該查閱這個項目');
  if (description.length > 300) throw new Error('說明最多 300 個字元（會列在 image-summon 技能的目錄中）');
  fs.mkdirSync(knowledgeDir(), { recursive: true });
  const orig = input.originalName?.trim();
  if (orig && orig !== name) {
    assertExisting(orig);
    if (fs.existsSync(itemDir(name))) throw new Error(`已經有名為 ${name} 的項目`);
    fs.renameSync(itemDir(orig), itemDir(name));
  } else if (!orig) {
    if (fs.existsSync(itemDir(name))) throw new Error(`已經有名為 ${name} 的項目`);
    fs.mkdirSync(itemDir(name));
  }
  writeItem(name, description, String(input.body ?? ''));
  return getItem(name);
}

export function deleteItem(name: string): void {
  assertExisting(name);
  // only ever the one validated folder directly under the knowledge root
  fs.rmSync(itemDir(name), { recursive: true, force: true });
}

export function addItemFiles(name: string, sources: string[]): KnowledgeItem {
  assertExisting(name);
  const assets = path.join(itemDir(name), 'assets');
  fs.mkdirSync(assets, { recursive: true });
  for (const src of sources) {
    const st = fs.statSync(src);
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE) throw new Error(`檔案太大（單檔上限 8MB）：${path.basename(src)}`);
    const ext = path.extname(src).toLowerCase();
    const stem = path.basename(src, path.extname(src)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'file';
    let dest = path.join(assets, stem + ext);
    let k = 2;
    while (fs.existsSync(dest)) dest = path.join(assets, `${stem}-${k++}${ext}`);
    fs.copyFileSync(src, dest);
  }
  const cur = getItem(name);
  writeItem(name, cur.description, cur.body);
  return getItem(name);
}

export function removeItemFile(name: string, rel: string): KnowledgeItem {
  assertExisting(name);
  if (rel === ITEM_FILE) throw new Error(`不能刪除 ${ITEM_FILE}`);
  const p = inside(name, rel);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) fs.unlinkSync(p);
  const cur = getItem(name);
  writeItem(name, cur.description, cur.body);
  return getItem(name);
}
