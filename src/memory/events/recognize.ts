// 认出东西：她自己看到、读到、说到挂在喜欢 / 烦的事上的东西时，提她一句。
// 只认名字，不靠意思像：喜欢 / 烦的事（被并掉、撤掉的不算，腻了的算）挂成 about / by 的东西的名字、别名
// （一起的人、群挂的是 with，天天说到，不算）。规范化后少于 2 个字的不要；少于 3 个字的只在紧挨书名号、引号时认
// （「历史记录」里没有「史记」、「学生会长」里没有「会长」）；英文、数字开头结尾的要整词；全大写 4 个字母以内的（EVA）只认全大写。
// 库一变（多了写、有撤回）就在下一次认之前重建名字表：白天 like 新建、夜里整理、撤回以后都跟得上。
import type { Db } from "../../store/db.ts";
import { all, one } from "../../store/db.ts";
import { BRACKETS, isSelfName, likeLabel, normName } from "./schema.ts";
import type { Stance, Status } from "./schema.ts";
import { fmtDay } from "./render.ts";

/** 一段文字最多扫这么多字（网页、文件可能很长） */
const SCAN_MAX = 60_000;
/** 名字至少几个字（规范化后数） */
const NAME_MIN = 2;
/** 少于这么多字的名字，只在前后紧挨书名号、引号时才认（哪种文字都一样） */
const BARE_MIN = 3;
/** 紧挨着名字的开、合书名号和引号 */
const OPENERS = "《〈「『“‘\"'";
const CLOSERS = "》〉」』”’\"'";
/** 全大写、4 个字母以内的（EVA、UBW）：区分大小写，只认全大写（不然人名 Eva 也算） */
const CAPS = /^[A-Z]{1,4}$/;

export interface Recognized {
  /** 认出的名字（登记时的写法） */
  name: string;
  id: string; title: string; stance: Stance; status: Status;
  /** 喜欢中 / 腻了 / 烦着 / 不烦了 */
  state: string;
  /** 排序用：最近一下的时间（没有感受用改动时间，和 my_likes 同一个算法） */
  felt: number;
  last: { day: string; gist: string } | null;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** 字符类里要转义的：] \ ^ - */
const escapeClass = (s: string): string => s.replace(/[\]\\^-]/g, "\\$&");
const ASCII_EDGE = /[a-z0-9]/i;

export class Recognizer {
  private readonly db: Db;
  private readonly tz: string;
  private version = "";
  private re: RegExp | null = null;
  /** 全大写短名字另一个、区分大小写的正则 */
  private reCase: RegExp | null = null;
  /** 规范化后的名字 → 登记时的写法、对上的事 */
  private names = new Map<string, { display: string; events: Set<string> }>();

  constructor(db: Db, tz: string) {
    this.db = db;
    this.tz = tz;
  }

  /** 这段文字里认出了哪几件（skip 里的不要），最近一下新的在前 */
  find(text: string, skip: ReadonlySet<string> = new Set()): Recognized[] {
    this.load();
    if ((!this.re && !this.reCase) || !text) return [];
    const hits = new Map<string, string>();
    const scan = text.slice(0, SCAN_MAX);
    for (const re of [this.re, this.reCase]) {
      if (!re) continue;
      for (const m of scan.matchAll(re)) {
        const n = this.names.get(normName(m[0]));
        if (!n) continue;
        for (const id of n.events) if (!skip.has(id) && !hits.has(id)) hits.set(id, n.display);
      }
    }
    if (!hits.size) return [];
    return [...this.current([...hits.keys()]).values()].map((r) => ({ ...r, name: hits.get(r.id)! })).sort((a, b) => b.felt - a.felt || a.id.localeCompare(b.id));
  }

  /** 这几件现在的样子（还算数的喜欢 / 烦的事才有）：附之前再看一眼，状态变了照新的写，撤掉了就没有 */
  current(ids: string[]): Map<string, Omit<Recognized, "name">> {
    if (!ids.length) return new Map();
    const rows = all<{ id: string; title: string; stance: Stance; status: Status; felt: number; fat: number | null; fgist: string | null }>(this.db, `
      SELECT e.id, e.title, e.stance, e.status, COALESCE(f.at, e.updated_at) felt, f.at fat, f.gist fgist FROM mem_event e
      LEFT JOIN mem_entry f ON f.id = (SELECT n.id FROM mem_entry n WHERE n.event_id = e.id AND n.kind = 'feeling' ORDER BY n.at DESC, n.id DESC LIMIT 1)
      WHERE e.id IN (${ids.map(() => "?").join(",")}) AND e.stance IS NOT NULL AND e.status NOT IN ('superseded','retired')`, ...ids);
    return new Map(rows.map((r) => [r.id, {
      id: r.id, title: r.title, stance: r.stance, status: r.status, state: likeLabel(r), felt: Number(r.felt),
      last: r.fat === null ? null : { day: fmtDay(Number(r.fat), this.tz), gist: String(r.fgist ?? "") },
    }]));
  }

  /**
   * 名字表：库变了才重建。「变了」看三样：mem_op 最大的编号（有新写）、撤回过的批次有几个、批次最近一次收尾的时刻——
   * 没有冲突的撤回只把 mem_op 挪到留档批次名下、不加新行，只看最大编号会漏掉
   */
  private load(): void {
    const v = String(one<{ v: string }>(this.db, `SELECT (SELECT COALESCE(MAX(id), 0) FROM mem_op) || ':' || (SELECT COUNT(*) FROM mem_batch WHERE state = 'reverted')
      || ':' || (SELECT COALESCE(MAX(ended_at), 0) FROM mem_batch) v`)?.v ?? "");
    if (v === this.version) return;
    this.version = v;
    const names = new Map<string, { display: string; events: Set<string> }>();
    const rows = all<{ id: string; name: string; aliases: string }>(this.db, `
      SELECT e.id, t.name, t.aliases FROM mem_event e JOIN mem_event_entity ee ON ee.event_id = e.id JOIN mem_entity t ON t.id = ee.entity_id
      WHERE e.stance IS NOT NULL AND e.status NOT IN ('superseded','retired') AND ee.role IN ('about', 'by')`);
    for (const r of rows) {
      let aliases: string[] = [];
      try { aliases = JSON.parse(r.aliases || "[]") as string[]; } catch { aliases = []; }
      for (const name of [r.name, ...aliases]) {
        const key = normName(name);
        if ([...key].length < NAME_MIN || isSelfName(name)) continue;
        const cur = names.get(key) ?? { display: name.trim(), events: new Set<string>() };
        cur.events.add(r.id);
        names.set(key, cur);
      }
    }
    this.names = names;
    // 长的名字先试（同一处既是「会长」又是「学生会长」时认长的）；字之间允许空白；
    // 短的要紧挨书名号、引号；英文、数字的边上要断开；全大写短名字单独一个区分大小写的正则
    const ci: string[] = [], cs: string[] = [];
    for (const name of [...names.values()].map((n) => n.display).sort((a, b) => normName(b).length - normName(a).length)) {
      const chars = [...name.replace(BRACKETS, "").replace(/\s+/g, "")];
      const core = chars.map(escapeRe).join("\\s*");
      const pat = [...normName(name)].length < BARE_MIN
        ? `(?<=[${escapeClass(OPENERS)}])${core}(?=[${escapeClass(CLOSERS)}])`
        : `${ASCII_EDGE.test(chars[0] ?? "") ? "(?<![a-zA-Z0-9])" : ""}${core}${ASCII_EDGE.test(chars.at(-1) ?? "") ? "(?![a-zA-Z0-9])" : ""}`;
      (CAPS.test(chars.join("")) ? cs : ci).push(pat);
    }
    this.re = ci.length ? new RegExp(ci.join("|"), "giu") : null;
    this.reCase = cs.length ? new RegExp(cs.join("|"), "gu") : null;
  }
}
