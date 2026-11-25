import { app } from 'electron';
import { memorySkillFiles, SkillCatalog, SkillFileEntry, SkillFiles, SkillsExtension } from '@modelcontextprotocol/server/ext/skills';
import { nodeSkillFiles } from '@modelcontextprotocol/server/ext/skills/node';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { currentCapabilities } from './jobs';
import { ITEM_FILE, knowledgeDir, KnowledgeSummary, listKnowledge, localPath } from './knowledge';
import { describeSpec } from './spec';

/*
 * Skills over MCP (SEP-2640, extension id `io.modelcontextprotocol/skills`).
 *
 * Image Summon publishes exactly ONE skill, `image-summon`:
 *   SKILL.md                         how to use the generator well + an index of the knowledge base
 *   references/generator.md          the generator selected in the tray (regenerated on every switch)
 *   knowledge/<item>/README.md       the user's knowledge items (style guides, logos, brand colours…)
 *   knowledge/<item>/assets/…        their attachments
 *
 * Knowledge items live in %APPDATA%\image-summon\knowledge and are managed in the settings page.
 * Clients discover the skill with `skills/list` and read files as `skill://image-summon/…` resources.
 */

export const BUILTIN_SKILL = 'image-summon';

const BASE_DESCRIPTION =
  'Generate or edit images with the local Image Summon MCP server (generate_image / get_image_job). Use whenever the user wants an ' +
  'illustration, icon, banner, mock-up, photo, texture or any other picture created or modified, or wants generated art saved into their project.';

function skillDescription(items: KnowledgeSummary[]): string {
  if (!items.length) return BASE_DESCRIPTION;
  let names = items.map((i) => i.name).join(', ');
  if (names.length > 300) names = names.slice(0, 297) + '...';
  return `${BASE_DESCRIPTION} Includes the user's image knowledge base (${names}): check it for house style, brand assets and logos before generating.`;
}

function knowledgeSection(items: KnowledgeSummary[]): string {
  const lines = ['## Knowledge base (provided by the user)', ''];
  if (!items.length) {
    lines.push('The user has not added any knowledge items yet. They can add style guides, brand colours, logos or character',
      'sheets in Image Summon (settings → 知識庫); they will be listed here.');
    return lines.join('\n');
  }
  lines.push('The user keeps reusable image knowledge here. **Before generating, check whether an item matches the request**',
    '(e.g. anything for their company → the brand/logo item) and follow it. Read an item with `resources/read` on its',
    'URI (relative to this skill). Attached images can be passed to `generate_image` in `input_images` by local path.', '');
  for (const it of items) {
    lines.push(`### ${it.name}`, '', it.description || '(no description)', '', `- Read: \`knowledge/${it.name}/${ITEM_FILE}\``);
    for (const f of it.files) lines.push(`- Attachment \`knowledge/${it.name}/${f}\` — local path: \`${localPath(it.name, f)}\``);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function skillMd(items: KnowledgeSummary[]): string {
  return `---
name: ${BUILTIN_SKILL}
description: ${JSON.stringify(skillDescription(items))}
---

# Image Summon

Image Summon is an always-running image generator in the user's Windows tray. Every agent talks to the same
instance through MCP. Which backend actually draws the picture (Codex CLI, OpenRouter, or a custom API) is chosen
by the user in the tray settings — **never assume a model or parameter; check first.**

## Workflow

1. **Check what the active generator accepts.** Read \`references/generator.md\` (or the
   \`image-summon://generator/spec\` resource, or call \`get_generator_info\`). The \`generate_image\` input schema
   is generated from the same data: only the listed \`resolution\`, \`aspect_ratio\`, \`quality\`, \`n\`,
   \`background\`, \`output_format\`, \`seed\` and \`input_images\` values are valid. When the user switches
   generator, the schema changes and a list-changed notification is sent.
2. **Write a rich prompt** (see below) and call \`generate_image\`.
3. **Deliver the file.** The result lists absolute paths of the saved images plus a preview. If the image belongs
   in the user's project, pass \`output_path\` (an absolute file path such as \`C:\\\\proj\\\\assets\\\\hero.png\`,
   or an existing folder) so a copy lands there directly — don't copy files by hand.
4. **Iterate** by editing: pass the previous result's path in \`input_images\` and describe only the change.

## Writing prompts

Describe, in this order:
- **Subject** — what is in the picture, with concrete details (count, pose, materials, expressions).
- **Medium & style** — e.g. "flat vector icon", "35mm photograph", "watercolor", "isometric 3D render".
- **Composition** — framing, camera angle, where the subject sits, negative space for text.
- **Light & palette** — time of day, mood, named colours or hex codes for brand work.
- **Background** — plain/transparent for assets, a scene for illustrations.
- **Text** — quote any words to render exactly, and say where they go. Keep them short.

Prefer one clear image per call over a collage. For UI assets ask for "centered, no border, plain background".

## Choosing parameters

- \`aspect_ratio\`: match the destination (16:9 hero/banner, 1:1 icon/avatar, 9:16 phone wallpaper, 3:2 photo).
- \`resolution\`: 1K for drafts and previews, 2K/4K only for final assets (slower and more expensive).
- \`quality\`: leave at the default unless the user asks for a final, high-quality render.
- \`background: transparent\` needs \`output_format\` png or webp.
- \`n > 1\` produces variations to choose from; cost scales with \`n\`.
- **Codex mode** has no size/aspect parameters — describe the framing ("wide 16:9 banner") in the prompt.
  It does support \`background: transparent\` natively (real alpha PNG): describe only the isolated subject and
  leave out any backdrop, floor or scene, or the background may come back opaque. Check the result for warnings.
  Alpha note: Codex's cut-out usually leaves the "solid" subject slightly translucent (alpha ≈ 250–254, i.e.
  98–99 % opaque) rather than fully opaque, plus a soft semi-transparent edge/glow. It is invisible on light
  backgrounds but can show faintly on dark ones. Mention this when the asset is for a dark UI or will be stacked;
  if the user needs a perfectly solid subject, suggest flattening alpha (e.g. alpha ≥ 250 → 255) in an image editor.

## Long generations

Generation takes 10 s – 3 min. Progress notifications are sent every few seconds. If your client has short tool
timeouts, call \`generate_image\` with \`async: true\`, then poll \`get_image_job\` (it can block up to
\`wait_seconds\`, max 300).

## Errors

- *NOT READY* in the tool description or an error saying the generator is not configured: tell the user to open
  Image Summon from the tray and finish setup (e.g. log in to OpenRouter). Don't retry in a loop.
- A failed result includes the provider's error detail — summarize it for the user; content-policy refusals need
  a reworded prompt, not a retry.

${knowledgeSection(items)}
`;
}

function builtinFiles(serverUrl: string): Record<string, string> {
  return {
    [`${BUILTIN_SKILL}/SKILL.md`]: skillMd(listKnowledge()),
    [`${BUILTIN_SKILL}/references/generator.md`]: describeSpec(currentCapabilities(), serverUrl),
  };
}

const KNOWLEDGE_MOUNT = `${BUILTIN_SKILL}/knowledge`;

/**
 * One storage tree for the catalog: the built-in files in memory, with the user's knowledge folder
 * mounted at image-summon/knowledge. Only folders that look like knowledge items are exposed, and no
 * SKILL.md can appear below the mount, so the user's content never becomes a separate skill.
 */
function mergedFiles(builtin: SkillFiles, dir: string): SkillFiles {
  const disk = nodeSkillFiles(dir);
  const items = () => new Set(listKnowledge().map((i) => i.name));
  const underMount = (p: string) => p === KNOWLEDGE_MOUNT || p.startsWith(KNOWLEDGE_MOUNT + '/');
  const rel = (p: string) => p.slice(KNOWLEDGE_MOUNT.length + 1);
  return {
    async list(d) {
      if (d === BUILTIN_SKILL) {
        const own = await builtin.list(d);
        return items().size ? [...own, { name: 'knowledge', kind: 'directory' } as SkillFileEntry] : own;
      }
      if (d === KNOWLEDGE_MOUNT) return [...items()].map((name) => ({ name, kind: 'directory' } as SkillFileEntry));
      if (underMount(d)) {
        const entries = await disk.list(rel(d)).catch((e: any) => { if (e?.code === 'ENOENT') return []; throw e; });
        return entries.filter((e) => e.name !== 'SKILL.md');
      }
      return builtin.list(d);
    },
    read(p) {
      return underMount(p) ? disk.read(rel(p)) : builtin.read(p);
    },
  };
}

export interface SkillWarningInfo { path: string; message: string }

class SkillHub {
  private catalog?: SkillCatalog;
  private record: Record<string, string> = {};
  private serverUrl = '';
  private queue: Promise<unknown> = Promise.resolve();
  warnings: SkillWarningInfo[] = [];
  /** Called when the list of skills (names/descriptions) changed, so stateless clients can be told. */
  onListChanged?: () => void;

  async init(serverUrl: string): Promise<void> {
    this.serverUrl = serverUrl;
    const dir = knowledgeDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    Object.assign(this.record, builtinFiles(serverUrl));
    this.warnings = [];
    this.catalog = await SkillsExtension.load(mergedFiles(memorySkillFiles(this.record), dir), {
      onWarning: (w) => { this.warnings.push(w); console.warn('[skills]', w.path, w.message); },
    });
  }

  /** The extension to attach to each McpServer, or undefined before init. */
  get extension(): SkillsExtension | undefined {
    return this.catalog;
  }

  /** What agents get: the skill entry with every published file. */
  published() {
    const s = (this.catalog?.entries ?? []).find((e) => e.frontmatter.name === BUILTIN_SKILL);
    if (!s) return undefined;
    return {
      uri: s.uri,
      name: s.frontmatter.name,
      description: s.frontmatter.description,
      files: Array.isArray(s.resources) ? s.resources.map((r) => ({ uri: r.uri, size: r.size })) : [],
    };
  }

  /** Rescan (user folder edits) and regenerate the built-in generator reference. Serialized. */
  reload(serverUrl?: string): Promise<void> {
    const run = async () => {
      if (!this.catalog) return;
      if (serverUrl) this.serverUrl = serverUrl;
      const next = builtinFiles(this.serverUrl);
      for (const k of Object.keys(this.record)) if (!(k in next)) delete this.record[k];
      Object.assign(this.record, next);
      this.warnings = [];
      try {
        const changes = await this.catalog.reload();
        if (changes.listChanged) this.onListChanged?.();
      } catch (e: any) {
        this.warnings.push({ path: knowledgeDir(), message: e?.message ?? String(e) });
        console.warn('[skills] reload failed', e);
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

export const skills = new SkillHub();
