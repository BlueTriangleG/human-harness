// 人格：她现有的人格文件原样照搬，拼成所有脑区共用的"纪元前缀"（系统提示的追加部分）。
// 前缀在一个会话里永远不变（缓存规则）；压缩块只在翻页时加进新前缀。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "../memory/tokens.ts";
import { B, fromEveryPack } from "../lang/index.ts";
import { LAYOUT } from "./layout.ts";

/** HH 自己的运行说明：放在最前面，所有脑区一样。和人格文件里 OpenClaw 时代的说法冲突时以这里为准。 */
export const hhRuntimeNote = (): string => B.persona.runtimeNote;

export interface PersonaFile { path: string; text: string }

export class Persona {
  readonly name: string;
  readonly files: PersonaFile[];
  constructor(name: string, files: PersonaFile[]) {
    this.name = name;
    this.files = files;
  }

  static load(workspace: string, name: string, files: readonly string[]): Persona {
    const loaded: PersonaFile[] = [];
    for (const rel of files) {
      const p = join(workspace, rel);
      if (!existsSync(p)) throw new Error(`persona file missing: ${p}`);
      loaded.push({ path: rel, text: readFileSync(p, "utf8") });
    }
    return new Persona(name, loaded);
  }

  /** 身份 + 长期记忆部分（不含压缩块） */
  identityText(): string {
    return this.files.map((f) => `<file path="${f.path}">\n${f.text.trim()}\n</file>`).join("\n\n");
  }
}

export interface Block { id: number; text: string; tokens: number; created: number }

/**
 * 她用的语言（config.writingLanguage）那一句，只在这里写：运行说明末尾、夜里整理的前缀（sleep/host.ts）都用它。
 * 没配、空白、不是字符串（配置是手改的 JSON，写成 null、数字也不能让控制台和 hhd 起不来）都给空串
 */
export function languageLine(language: unknown): string {
  const lang = typeof language === "string" ? language.trim() : "";
  return lang ? B.persona.languageLine(lang) : "";
}

/** 运行说明里有几句只对有这些东西的角色才对：配了 OpenClaw 网关（gateway.authFile），工作区里有修系统那一页。不给 = 都有（第一个角色） */
export interface RuntimeFacts { openclaw: boolean; repairGuide: boolean }

/** 角色有没有这两样：配置里写了 OpenClaw 网关的凭据文件（gateway.authFile），工作区里有没有修系统那一页 */
export function runtimeFactsOf(cfg: { workspace: string; gateway?: { authFile?: string } }): RuntimeFacts {
  return { openclaw: Boolean(cfg.gateway?.authFile), repairGuide: existsSync(join(cfg.workspace, B.persona.repairGuidePage)) };
}

/**
 * 运行说明 + 她用的语言那一句（languageLine）；没有那一句就是原样的运行说明。所有脑区共用一个前缀，所以一条管所有脑区。
 * 角色没有的东西（facts），说明里讲它的那几句照语言包换掉；都有就是原文，一字不动
 */
export function runtimeNote(language: unknown, facts: RuntimeFacts = { openclaw: true, repairGuide: true }): string {
  let note = hhRuntimeNote();
  if (!facts.openclaw) for (const [from, to] of B.persona.runtimeNoteNoOpenClaw) note = note.replace(from, to);
  if (!facts.repairGuide) note = note.replace(B.persona.runtimeNoteNoRepairGuide[0], B.persona.runtimeNoteNoRepairGuide[1]);
  const line = languageLine(language);
  return line ? `${note}\n${line}` : note;
}

/** 记忆类的文件：放在过渡句之后，用第一人称（人格用"你"，记忆是"我"自己的） */
export const MEMORY_FILES: ReadonlySet<string> = new Set([LAYOUT.soulMemory, LAYOUT.snapshot]);

/** 人格和记忆的分界 */
export const memoryFrame = (): string => B.persona.memoryFrame;

/**
 * 纪元前缀 = 运行说明 + 人格文件（"你"）+ 书架目录（开了才有）+ 过渡句 + 记忆（账本快照 + 这次醒来以后的压缩块，第一人称）。所有脑区完全一样。
 */
export function buildPrefix(persona: Persona, blocks: readonly Block[], extra: { midterm?: string; shelf?: string; language?: string; guides?: string; facts?: RuntimeFacts } = {}): string {
  const fileText = (f: PersonaFile) => `<file path="${f.path}">\n${f.text.trim()}\n</file>`;
  const self = persona.files.filter((f) => !MEMORY_FILES.has(f.path)).map(fileText).join("\n\n");
  const mid = Boolean(extra.midterm?.trim());
  const memory = persona.files.filter((f) => MEMORY_FILES.has(f.path))
    .map((f) => fileText(mid ? { ...f, text: trimForMidterm(f.path, f.text) } : f));
  if (extra.midterm?.trim()) memory.push(extra.midterm.trim());   // 中期 = 事件库最近这一段的视图
  if (blocks.length) {
    memory.push(
      B.persona.compactedMemoryHeading + blocks.map((b, i) => B.persona.compactedMemoryBlock(i + 1, b.text.trim())).join("\n\n"),
    );
  }
  const parts = [runtimeNote(extra.language ?? "", extra.facts)];
  if (extra.guides?.trim()) parts.push(extra.guides.trim());   // the on modules' guides: right after the runtime note
  parts.push(self);
  if (extra.shelf?.trim()) parts.push(extra.shelf.trim());   // 书架目录：人格之后、过渡句之前（learning.shelf）
  if (memory.length) parts.push(`${memoryFrame()}\n\n${memory.join("\n\n")}`);
  return parts.join("\n\n---\n\n");
}

/** 前缀里带了中期视图时，这个文件给的样子：账本快照去掉旧事件线那几段（dropThreadTiers），别的文件原样。考场的开头也用它 */
export function trimForMidterm(path: string, text: string): string {
  return path === LAYOUT.snapshot ? dropThreadTiers(text) : text;
}

/**
 * 账本快照里按旧事件线文件排的几段（最近 N 天有进展的、几天前动过的、只记个名）和那句窗口说明；开了事件库的中期视图就由它代替。
 * 人物近况主人那节手抄的「他最近 3 天直接说的」一串也去掉：中期视图里有他这 3 天的原话（分工）。
 */
const OWNER_QUOTES = /^\s*-\s*他最近\s*3\s*天(直接)?说的/;
const DATED_ITEM = /^\s*-\s*\d{1,2}-\d{1,2}\b/;
export function dropThreadTiers(text: string): string {
  const out: string[] = [];
  let skipping = false;
  let quotes = false;
  for (const l of text.split("\n")) {
    if (fromEveryPack((p) => p.brain.forms.threadTier).some((r) => r.test(l))) { skipping = true; continue; }
    if (skipping && /^#{1,3} /.test(l)) skipping = false;
    if (skipping) continue;
    if (OWNER_QUOTES.test(l)) { quotes = true; continue; }
    if (quotes && DATED_ITEM.test(l)) continue;
    quotes = false;
    if (fromEveryPack((p) => p.brain.forms.threadWindow).some((r) => r.test(l)) || fromEveryPack((p) => p.brain.forms.threadNone).includes(l.trim())) continue;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function prefixTokens(prefix: string): number { return estimateTokens(prefix); }
