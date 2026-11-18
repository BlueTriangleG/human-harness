#!/usr/bin/env node
// npx human-harness starts here. This file alone has to run on an old Node: it checks the Node it runs on and, when that
// is too old for the installer (bin/npx.mjs needs 18: node:readline/promises, fs.cpSync, ?? and top-level await), says
// what to do instead of failing on a line nobody can read (measured 11-19: Node 16.0 and 14 stopped at the import of
// readline/promises, Node 12 at the first ??). So nothing here is newer than what Node 12 parses, and the installer is
// loaded only after the check.
const [major] = process.versions.node.split(".").map(Number);
if (major < 18) {
  const args = process.argv.slice(2), i = args.indexOf("--lang"), lang = process.env.LC_ALL || process.env.LANG || "";
  const pick = i >= 0 ? args[i + 1] : /^zh/.test(lang) ? "zh" : /^en/.test(lang) ? "en" : "";
  const v = process.versions.node, mac = process.platform === "darwin";
  const en = [
    `HH's installer needs Node.js 18 or newer, and this terminal runs Node.js ${v}.`,
    mac ? "(It is only for starting the installer: HH then downloads the Node.js it runs on by itself.)" : "(HH itself runs on Node.js 24.18 or newer: install that one.)",
    "To go on:",
    `  1. Install Node.js ${mac ? "18 or newer" : "24.18 or newer"}: the LTS from https://nodejs.org${mac ? ", or with Homebrew: brew install node" : ""} (with nvm: nvm install --lts).`,
    "  2. Open a new terminal window and check which Node.js it runs: node -v",
    `     It should say v${mac ? "18" : "24.18"} or higher. If it still shows ${v}, an older one comes first on PATH: which node says where it is.`,
    "  3. Run npx human-harness again.",
  ];
  const zh = [
    `HH 的安装程序要 Node.js 18 或更新，这个终端里的是 Node.js ${v}。`,
    mac ? "（它只是用来启动安装程序：HH 之后会自己下它要用的 Node.js。）" : "（HH 本身要 Node.js 24.18 或更新：装这个版本。）",
    "接下来：",
    `  1. 装 Node.js ${mac ? "18 或更新" : "24.18 或更新"}：从 https://nodejs.org 下 LTS${mac ? "，或者用 Homebrew：brew install node" : ""}（用 nvm 的话：nvm install --lts）。`,
    "  2. 新开一个终端窗口，查一下它用的 Node.js：node -v",
    `     应该是 v${mac ? "18" : "24.18"} 或更高。要是还显示 ${v}，说明 PATH 上排在前面的是旧的那个：which node 能看到它在哪。`,
    "  3. 再跑一次 npx human-harness。",
  ];
  console.log(pick === "en" ? en.join("\n") : pick === "zh" ? zh.join("\n") : `${en.join("\n")}\n\n${zh.join("\n")}`);
  process.exit(1);
}
import("./npx.mjs");
