import { app } from 'electron';
import { memorySkillFiles, SkillCatalog, SkillFileEntry, SkillFiles, SkillsExtension } from '@modelcontextprotocol/server/ext/skills';
import { nodeSkillFiles } from '@modelcontextprotocol/server/ext/skills/node';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { currentCapabilities } from './jobs';
import { describeSpec } from './spec';

/*
 * Skills over MCP (SEP-2640, extension id `io.modelcontextprotocol/skills`).
 *
 * Image Summon serves one catalog to every connected agent:
 *  - the built-in `image-summon` skill (how to use the generator well), whose
 *    `references/generator.md` always reflects the generator selected in the tray;
 *  - any skills the user drops into `%APPDATA%\image-summon\skills\<name>\SKILL.md`
 *    (art-direction guides, brand style sheets, …), shared with every agent at once.
 *
 * Clients discover them with `skills/list` and read files as `skill://…` resources.
 */

export const BUILTIN_SKILL = 'image-summon';

const SKILL_MD = `---
name: ${BUILTIN_SKILL}
description: Generate or edit images with the local Image Summon MCP server (generate_image / get_image_job). Use whenever the user wants an illustration, icon, banner, mock-up, photo, texture or any other picture created or modified, or wants generated art saved into their project.
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

## Long generations

Generation takes 10 s – 3 min. Progress notifications are sent every few seconds. If your client has short tool
timeouts, call \`generate_image\` with \`async: true\`, then poll \`get_image_job\` (it can block up to
\`wait_seconds\`, max 300).

## Errors

- *NOT READY* in the tool description or an error saying the generator is not configured: tell the user to open
  Image Summon from the tray and finish setup (e.g. log in to OpenRouter). Don't retry in a loop.
- A failed result includes the provider's error detail — summarize it for the user; content-policy refusals need
  a reworded prompt, not a retry.

## More skills

The user can add their own skills (style guides, brand rules, recurring art directions) in Image Summon's skills
folder; they appear in this same catalog. If one matches the request, follow it together with this skill.
`;

function builtinFiles(serverUrl: string): Record<string, string> {
  return {
    [`${BUILTIN_SKILL}/SKILL.md`]: SKILL_MD,
    [`${BUILTIN_SKILL}/references/generator.md`]: describeSpec(currentCapabilities(), serverUrl),
  };
}

export function userSkillsDir(): string {
  return path.join(app.getPath('userData'), 'skills');
}

/** Built-in skills in memory plus the user's skills folder, as one storage tree. */
function mergedFiles(builtin: SkillFiles, userDir: string): SkillFiles {
  const isBuiltin = (p: string) => p === BUILTIN_SKILL || p.startsWith(BUILTIN_SKILL + '/');
  const user = nodeSkillFiles(userDir);
  const userList = async (dir: string): Promise<SkillFileEntry[]> => {
    try { return await user.list(dir); } catch (e: any) {
      if (e?.code === 'ENOENT') return [];
      throw e;
    }
  };
  return {
    async list(dir) {
      if (dir === '') {
        const own = await builtin.list('');
        const extra = (await userList('')).filter((e) => e.name !== BUILTIN_SKILL);
        return [...own, ...extra];
      }
      return isBuiltin(dir) ? builtin.list(dir) : userList(dir);
    },
    read(p) {
      return isBuiltin(p) ? builtin.read(p) : user.read(p);
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
    const dir = userSkillsDir();
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

  entries() {
    return (this.catalog?.entries ?? []).map((s) => ({
      uri: s.uri,
      name: s.frontmatter.name,
      description: s.frontmatter.description,
      files: Array.isArray(s.resources) ? s.resources.length : 0,
      builtin: s.uri.startsWith(`skill://${BUILTIN_SKILL}/`),
    }));
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
        this.warnings.push({ path: userSkillsDir(), message: e?.message ?? String(e) });
        console.warn('[skills] reload failed', e);
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

export const skills = new SkillHub();
