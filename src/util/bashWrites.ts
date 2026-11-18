// 一条 Bash 命令往哪些文件里写：退役文件的把关用（brain.ts 的 retiredFileGuard）。
// 只认常见的写法，是提醒、不是安全边界（python -c、脚本里写的都看不到）：
//   重定向 > >> >| &> &>> <> 和带编号的 2> 2>>（>&2、2>&1 这种复制文件描述符的不算）；
//   tee [-a] 的文件；sed -i（GNU 的 -i、-i.bak、-Ei，BSD 的 -i ''）的文件；
//   cp / mv / install / rsync 的目标（最后一个参数、-t 目录；目标可能是目录，所以「目标/源文件名」也算）；
//   cd 过去以后的相对路径；heredoc 的正文不当命令看。
// 只读的（cat、grep、rg、head、cp 的源……）不算。引号去掉；~、$HOME、绝对路径照原样，交给调用方的正则（只认路径结尾）。
// 学习系统有自己的一套（learning/associate.ts 的 shellSegments、bashReads），那边只管读，这里不碰它。
import { posix } from "node:path";

interface Segment { words: string[]; outs: string[] }

/** 拆成一段一段的简单命令：每段的词（去了引号）和重定向写进去的目标 */
function segments(cmd: string): Segment[] {
  const segs: Segment[] = [{ words: [], outs: [] }];
  const heredocs: Array<{ delim: string; strip: boolean }> = [];
  let word = "";
  let any = false;      // 这个词有内容（'' 也算一个词）
  let quoted = false;   // 这个词里有引号（"2">x 的 2 不是文件描述符）
  let next: "out" | "in" | "heredoc" | null = null;   // 下一个词是重定向的目标 / 输入 / heredoc 的分隔符
  let strip = false;    // <<- ：正文和分隔符前面的 tab 去掉
  const end = (): void => {
    if (!any) return;
    if (next === "out") segs.at(-1)!.outs.push(word);
    else if (next === "heredoc") heredocs.push({ delim: word, strip });
    else if (next === null) segs.at(-1)!.words.push(word);
    next = null; word = ""; any = false; quoted = false;
  };
  const cut = (): void => {
    end();
    next = null;
    const last = segs.at(-1)!;
    if (last.words.length || last.outs.length) segs.push({ words: [], outs: [] });
  };
  // >&2、<&0、>&- 这种：跳过后面的编号，返回新的位置；不是编号（>& 文件）返回 -1
  const dupFd = (k: number): number => {
    const m = /^[ \t]*(\d+|-)(?=$|[\s;|&<>()])/.exec(cmd.slice(k));
    return m ? k + m[0].length - 1 : -1;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      word += cmd.slice(i + 1, j < 0 ? cmd.length : j);
      any = true; quoted = true;
      i = j < 0 ? cmd.length : j;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === "\\" && j + 1 < cmd.length && '"\\$`\n'.includes(cmd[j + 1]!)) j++;
        word += cmd[j];
      }
      any = true; quoted = true;
      i = j;
    } else if (c === "\\") {
      if (cmd[i + 1] !== "\n") { word += cmd[i + 1] ?? ""; any = true; }
      i++;
    } else if (c === "#" && !any) {
      const j = cmd.indexOf("\n", i);
      i = (j < 0 ? cmd.length : j) - 1;   // 注释到行尾（换行留给下一圈）
    } else if (c === "\n") {
      cut();
      // 这一行开过的 heredoc：正文跳过，到只有分隔符的那一行为止
      let pos = i + 1;
      for (const h of heredocs.splice(0)) {
        while (pos < cmd.length) {
          const nl = cmd.indexOf("\n", pos);
          const stop = nl < 0 ? cmd.length : nl;
          const line = cmd.slice(pos, stop);
          pos = stop + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        }
      }
      i = pos - 1;
    } else if (c === " " || c === "\t" || c === "\r") {
      end();
    } else if (c === ">" || c === "<") {
      if (/^\d+$/.test(word) && !quoted) { word = ""; any = false; }   // 2> 的 2
      else end();
      if (c === ">") {
        let k = i + 1;
        if (cmd[k] === ">" || cmd[k] === "|") k++;
        if (cmd[k] === "(") { i = k - 1; continue; }        // >(…) 进程替换
        if (cmd[k] === "&") {
          const d = dupFd(k + 1);
          if (d >= 0) { i = d; continue; }                   // >&2
          k++;                                               // >& 文件
        }
        next = "out"; i = k - 1;
      } else if (cmd.startsWith("<<<", i)) {
        next = "in"; i += 2;                                 // here-string：后面是数据
      } else if (cmd[i + 1] === "<") {
        strip = cmd[i + 2] === "-";
        next = "heredoc"; i += strip ? 2 : 1;
      } else if (cmd[i + 1] === ">") {
        next = "out"; i++;                                   // <> 读写打开
      } else if (cmd[i + 1] === "&") {
        const d = dupFd(i + 2);
        if (d >= 0) i = d; else { next = "in"; i++; }
      } else if (cmd[i + 1] !== "(") {
        next = "in";                                         // <(…) 进程替换交给下一圈的 (
      }
    } else if (c === "&" && cmd[i + 1] === ">") {
      end();
      next = "out"; i += cmd[i + 2] === ">" ? 2 : 1;          // &> &>>
    } else if (";|&()".includes(c)) {
      cut();
    } else {
      word += c; any = true;
    }
  }
  end();
  return segs;
}

/** 前面可以套着的命令（sudo tee、env X=1 sed -i……），和它们带值的选项 */
const WRAPPERS = new Map<string, RegExp | null>([
  ["sudo", /^-[ugCDhprtU]$/], ["env", /^-[uCS]$/], ["nice", /^-n$/], ["command", null], ["nohup", null], ["time", null], ["exec", null], ["builtin", null],
]);
/** cp / mv / install / rsync 带值的短选项；-t 是不是「目标目录」（rsync 的 -t 是保留时间） */
const COPIERS = new Map<string, { value: RegExp; targetDir: boolean }>([
  ["cp", { value: /^-S$/, targetDir: true }], ["mv", { value: /^-S$/, targetDir: true }],
  ["install", { value: /^-[SmogB]$/, targetDir: true }], ["rsync", { value: /^-[eBfT]$/, targetDir: false }],
]);

/** 这条命令写进去的所有路径（cd 过的相对路径接上目录、规整过） */
export function bashWriteTargets(cmd: string): string[] {
  const out: string[] = [];
  let dir = "";   // cd 到了哪（相对开头的工作目录；"" 是没 cd 过或不知道）
  const at = (p: string): string => posix.normalize(dir && !/^[/~$]/.test(p) ? posix.join(dir, p) : p);
  for (const seg of segments(cmd)) {
    for (const o of seg.outs) out.push(at(o));
    let words = seg.words;
    for (;;) {
      const w = words[0];
      if (w === undefined) break;
      if (/^[A-Za-z_]\w*=/.test(w)) { words = words.slice(1); continue; }   // X=1 cmd
      const opt = WRAPPERS.get(posix.basename(w));
      if (opt === undefined) break;
      words = words.slice(1);
      while (words[0]?.startsWith("-")) words = words.slice(opt?.test(words[0]!) ? 2 : 1);
    }
    if (!words.length) continue;
    const name = posix.basename(words[0]!);
    const args = words.slice(1);
    if (name === "cd") {
      const d = args.find((a) => !a.startsWith("-") || a === "-");
      dir = d === undefined ? "~" : d === "-" ? "" : at(d);
      continue;
    }
    // 选项和位置参数（-- 之后都是位置参数）；valueOpt 认得的选项吃掉下一个词；targetDir：认 -t 目录 / --target-directory
    const split = (valueOpt?: RegExp, targetDir = false): { opts: string[]; pos: string[]; target?: string } => {
      const opts: string[] = []; const pos: string[] = [];
      let target: string | undefined;
      let more = true;
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (more && a === "--") { more = false; continue; }
        if (more && a.length > 1 && a.startsWith("-")) {
          if (targetDir) {
            if (a === "-t" || a === "--target-directory") { target = args[++i]; continue; }
            if (a.startsWith("--target-directory=")) { target = a.slice(a.indexOf("=") + 1); continue; }
            if (/^-t./.test(a)) { target = a.slice(2); continue; }
          }
          opts.push(a);
          if (valueOpt?.test(a)) i++;
          continue;
        }
        pos.push(a);
      }
      return target === undefined ? { opts, pos } : { opts, pos, target };
    };
    if (name === "tee") {
      for (const p of split().pos) out.push(at(p));
    } else if (name === "sed" || name === "gsed") {
      const { opts, pos } = split(/^-[ef]$/);
      // 脚本、BSD -i 后面的 '' / .bak 也在 pos 里：它们对不上文件路径，一起算进去没关系
      if (opts.some((o) => /^-[A-Za-z]*i/.test(o) || o === "--in-place" || o.startsWith("--in-place="))) for (const p of pos) out.push(at(p));
    } else if (COPIERS.has(name)) {
      const c = COPIERS.get(name)!;
      const { pos, target } = split(c.value, c.targetDir);
      if (target !== undefined) {
        for (const p of pos) out.push(at(posix.join(target, posix.basename(p))));
      } else if (pos.length >= 2) {
        const dest = pos.at(-1)!;
        out.push(at(dest));
        for (const p of pos.slice(0, -1)) out.push(at(posix.join(dest, posix.basename(p))));
      }
    }
  }
  return out;
}

/** 这条命令有没有往对得上 path 的文件里写 */
export function bashWritesTo(cmd: string, path: RegExp): boolean {
  return bashWriteTargets(cmd).some((p) => path.test(p));
}
