import * as fs from 'node:fs';
import * as path from 'node:path';
import { thumbnailDataUrl } from './images';
import { BUILTIN_SKILL, skills, userSkillsDir } from './skills';

/*
 * Create / edit / delete the user's own skills from the settings page.
 * Each skill is a folder under %APPDATA%\image-summon\skills\<name>\ with a SKILL.md and optional
 * attachments (logos, reference images, palettes…) in assets/. Attachments are listed in SKILL.md with
 * their absolute paths so a local agent can pass them straight to generate_image's input_images.
 */

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ATTACH_START = '<!-- image-summon:attachments:start (auto-generated, edit in Image Summon) -->';
const ATTACH_END = '<!-- image-summon:attachments:end -->';
const IMAGE_RE = /\.(png|jpe?g|webp|gif|svg)$/i;
const MAX_FILE = 15 * 1024 * 1024;

export interface SkillFileInfo { path: string; abs: string; bytes: number; image: boolean; thumb?: string }
export interface SkillDetail { name: string; description: string; body: string; files: SkillFileInfo[]; dir: string }
export interface SkillSummary { name: string; description: string; files: number; dir: string }

function skillDir(name: string) {
  return path.join(userSkillsDir(), name);
}

function assertName(name: string) {
  if (!NAME_RE.test(name) || name.length > 64) {
    throw new Error('技能名稱只能使用小寫英文字母、數字和連字號（例如 brand-style），最多 64 個字元，且不能以連字號開頭或結尾');
  }
  if (name === BUILTIN_SKILL) throw new Error(`「${BUILTIN_SKILL}」是內建技能的名稱，請換一個`);
}

function assertExisting(name: string) {
  assertName(name);
  if (!fs.existsSync(path.join(skillDir(name), 'SKILL.md'))) throw new Error(`找不到技能 ${name}`);
}

/** Resolve a path inside a skill folder, refusing anything that escapes it. */
function inside(name: string, rel: string): string {
  const base = skillDir(name);
  const p = path.resolve(base, rel);
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('路徑不在技能資料夾內');
  return p;
}

function parseSkillMd(text: string): { name: string; description: string; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { name: '', description: '', body: text };
  const front = m[1];
  const field = (k: string) => {
    const line = new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(front)?.[1]?.trim() ?? '';
    if (line.startsWith('"')) { try { return JSON.parse(line); } catch { /* fall through */ } }
    if (line.startsWith("'") && line.endsWith("'")) return line.slice(1, -1).replace(/''/g, "'");
    return line;
  };
  let body = m[2];
  const a = body.indexOf(ATTACH_START);
  const b = body.indexOf(ATTACH_END);
  if (a >= 0 && b > a) body = (body.slice(0, a) + body.slice(b + ATTACH_END.length)).replace(/\n{3,}$/g, '\n');
  return { name: field('name'), description: field('description'), body: body.replace(/^\n+/, '').trimEnd() };
}

function walkFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(dir, r));
    else if (e.isFile() && r !== 'SKILL.md') out.push(r);
  }
  return out.sort();
}

function attachmentSection(name: string, files: string[]): string {
  if (!files.length) return '';
  const lines = [ATTACH_START, '', '## Attached files', ''];
  lines.push('These files ship with this skill. Read them as `skill://` resources, or use the local absolute path —');
  lines.push('image files can be passed directly to `generate_image` in `input_images` (e.g. a logo to place in the image,');
  lines.push('or a style reference to match).', '');
  for (const f of files) {
    lines.push(`- [${f}](${f.split('/').map(encodeURIComponent).join('/')}) — local path: \`${path.join(skillDir(name), ...f.split('/'))}\``);
  }
  lines.push('', ATTACH_END);
  return lines.join('\n');
}

function writeSkillMd(name: string, description: string, body: string) {
  const dir = skillDir(name);
  const files = walkFiles(dir);
  const text = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`, // a JSON string is a valid YAML double-quoted scalar
    '---',
    '',
    body.trim() || `# ${name}`,
    '',
    attachmentSection(name, files),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text, 'utf8');
}

export function listUserSkills(): SkillSummary[] {
  const root = userSkillsDir();
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out: SkillSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const md = path.join(root, e.name, 'SKILL.md');
    if (!fs.existsSync(md)) continue;
    const p = parseSkillMd(fs.readFileSync(md, 'utf8'));
    out.push({ name: e.name, description: p.description, files: walkFiles(path.join(root, e.name)).length, dir: path.join(root, e.name) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(name: string): SkillDetail {
  assertExisting(name);
  const dir = skillDir(name);
  const p = parseSkillMd(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
  const files = walkFiles(dir).map((rel) => {
    const abs = path.join(dir, ...rel.split('/'));
    const image = IMAGE_RE.test(rel);
    return { path: rel, abs, bytes: fs.statSync(abs).size, image, thumb: image ? thumbnailDataUrl(abs, 120) : undefined };
  });
  return { name, description: p.description, body: p.body, files, dir };
}

export async function saveSkill(input: { originalName?: string; name: string; description: string; body: string }): Promise<SkillDetail> {
  const name = String(input.name ?? '').trim();
  const description = String(input.description ?? '').trim().replace(/\s*\n\s*/g, ' ');
  assertName(name);
  if (!description) throw new Error('請填寫說明：agent 會依這段文字判斷什麼時候該使用這個技能');
  if (description.length > 1024) throw new Error('說明最多 1024 個字元');
  const root = userSkillsDir();
  fs.mkdirSync(root, { recursive: true });
  const orig = input.originalName?.trim();
  if (orig && orig !== name) {
    assertExisting(orig);
    if (fs.existsSync(skillDir(name))) throw new Error(`已經有名為 ${name} 的技能`);
    fs.renameSync(skillDir(orig), skillDir(name));
  } else if (!orig) {
    if (fs.existsSync(skillDir(name))) throw new Error(`已經有名為 ${name} 的技能`);
    fs.mkdirSync(skillDir(name));
  }
  writeSkillMd(name, description, String(input.body ?? ''));
  await skills.reload();
  return getSkill(name);
}

export async function deleteSkill(name: string): Promise<void> {
  assertExisting(name);
  // only ever the one validated folder directly under the skills root
  fs.rmSync(skillDir(name), { recursive: true, force: true });
  await skills.reload();
}

export async function addSkillFiles(name: string, sources: string[]): Promise<SkillDetail> {
  assertExisting(name);
  const assets = path.join(skillDir(name), 'assets');
  fs.mkdirSync(assets, { recursive: true });
  for (const src of sources) {
    const st = fs.statSync(src);
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE) throw new Error(`檔案太大（上限 15MB）：${path.basename(src)}`);
    const ext = path.extname(src).toLowerCase();
    const stem = path.basename(src, path.extname(src)).replace(/[^\w.\-一-鿿]+/g, '-').replace(/^-+|-+$/g, '') || 'file';
    let dest = path.join(assets, stem + ext);
    let k = 2;
    while (fs.existsSync(dest)) dest = path.join(assets, `${stem}-${k++}${ext}`);
    fs.copyFileSync(src, dest);
  }
  const cur = getSkill(name);
  writeSkillMd(name, cur.description, cur.body);
  await skills.reload();
  return getSkill(name);
}

export async function removeSkillFile(name: string, rel: string): Promise<SkillDetail> {
  assertExisting(name);
  if (rel === 'SKILL.md') throw new Error('不能刪除 SKILL.md');
  const p = inside(name, rel);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) fs.unlinkSync(p);
  const cur = getSkill(name);
  writeSkillMd(name, cur.description, cur.body);
  await skills.reload();
  return getSkill(name);
}
