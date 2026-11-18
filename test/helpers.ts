// 测试工具：内存数据库 + 假内核 + 手动时钟，造一个完整的 Brain。
import "./names.ts";
import type { Rule } from "../src/gate/rules.ts";
import { openDb } from "../src/store/db.ts";
import type { Db } from "../src/store/db.ts";
import { deepMerge, loadConfig } from "../src/config.ts";
import type { Config, DeepPartial } from "../src/config.ts";
import { Logger, memorySink } from "../src/log.ts";
import type { LogRecord } from "../src/log.ts";
import { Persona } from "../src/persona/persona.ts";
import { Brain } from "../src/brain.ts";
import { openChannels } from "../src/channels/send.ts";
import { FakeDriver } from "../src/kernel/fake.ts";
import type { Runner } from "../src/util/run.ts";
import { People } from "../src/persona/people.ts";
import { sourcesFrom } from "../src/gate/sources.ts";
import type { GatewayCaller } from "../src/gateway/client.ts";
import type { Situation } from "../src/memory/situation.ts";
import type { EventMemory } from "../src/memory/events/memory.ts";
import type { LearningRuntime } from "../src/learning/runtime.ts";
import type { MiniFs } from "../src/sleep/record.ts";
import type { Modules } from "../src/modules/load.ts";

// #0041：她的 shell 里带着 HH_CONFIG（真配置）这些，手跑 node --test 时 loadConfig 会把它合进来，照默认值写的测试就假挂（11-07 brain.test.ts 挂了 17 个）。
// 测试一律不看外面的 HH_*；要用的测试自己设
for (const k of Object.keys(process.env)) if (k.startsWith("HH_")) delete process.env[k];

export class ManualClock {
  t: number;
  private timers: Array<{ at: number; fn: () => void }> = [];
  constructor(t: number) { this.t = t; }
  now = (): number => this.t;
  later = (fn: () => void, ms: number): void => { this.timers.push({ at: this.t + ms, fn }); };
  /** 时间往前走，到点的延时任务按顺序执行 */
  advance(ms: number): void {
    this.t += ms;
    const due = this.timers.filter((x) => x.at <= this.t).sort((a, b) => a.at - b.at);
    this.timers = this.timers.filter((x) => x.at > this.t);
    for (const d of due) d.fn();
  }
}

export interface TestBrain {
  brain: Brain;
  driver: FakeDriver;
  clock: ManualClock;
  logs: LogRecord[];
  runs: Array<{ cmd: string; args: readonly string[] }>;
  cfg: Config;
  db: Db;
}

export const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

export interface MakeOpts { /** 启动前就要设好的假内核（比如某个区开不起来） */ driver?: FakeDriver; db?: Db; fileExists?: (p: string) => boolean; readText?: (p: string) => string | null; mtime?: (p: string) => number | null; gateway?: GatewayCaller; reloadPersona?: () => Persona; situation?: Situation; mem?: EventMemory; people?: People; learning?: LearningRuntime; registryFile?: { mtime(): number | null; read(): Record<string, unknown> }; run?: Runner; sleepFs?: MiniFs; /** 两个气泡之间怎么等（测试自己放行） */ bubbleWait?: (ms: number) => Promise<void>; modules?: Modules; /** the machine is tight (the load guard's gate): long work is kept by main */ loadTight?: () => boolean; /** change the config before the brain is built (what an override cannot do, like taking a key away) */ editConfig?: (cfg: Config) => void }

/**
 * 测试用的角色：config/default.json 不再带任何一个角色的值（名字、路径、中文模板……），这里放的是当年从默认里拿走或清空的那些，
 * 原值原样。测试想要「照以前的默认配置」就从这里取（TEST_ROLE.names、TEST_ROLE.memory.people.template……），
 * 不要再去读 default.json 里已经没有的东西。
 */
export const TEST_ROLE = {
  "id": "mira",
  "lang": "zh",
  "names": {
    "me": "米拉",
    "owner": "ada",
    "notMe": [
      "米拉在补番"
    ]
  },
  "writingLanguage": "中文",
  "workspace": "/home/role/.openclaw/workspace",
  "stateDir": "/home/role/.hh",
  "schedule": {
    "timezone": "Australia/Melbourne"
  },
  "kernel": {
    "mcpServers": {
      "bili": {
        "type": "stdio",
        "command": "/home/role/.openclaw/workspace/plugins/bili/bin/bili-mcp",
        "args": []
      }
    }
  },
  "browser": {
    "userDataDir": "/home/role/.openclaw/browser/mira/user-data"
  },
  "tools": {
    "python": "/opt/homebrew/bin/python3",
    "wordListFile": "memory/不自然的词.md",
    "extra": ["computer"]
  },
  // the role's two channels, both through the gateway (a test that sends passes a fake one)
  "channels": {
    "whatsapp": { "via": "gateway" },
    "qqbot": { "via": "gateway" }
  },
  "skills": {
    "roots": [
      "/home/role/.openclaw/workspace/skills",
      "/home/role/.openclaw/plugin-skills"
    ],
    "names": [
      "bilibili"
    ],
    "discover": "/home/role/.openclaw/workspace/skills",
    "exclude": [
      "self-improving-agent"
    ]
  },
  "memory": {
    "peopleSwitchFile": "memory/archive/retired-20261103/ada.md",
    "retiredFiles": [
      {
        "path": "(^|/)memory/life/(taste|taste-archive|interests)\\.md$",
        "hippocampus": "taste.md、interests.md 11-03 起只读：喜欢的东西用 mem_* 写 stance 事件，口味写 soul/30 的提案。",
        "other": "口味日记 11-03 起不写了：喜欢上、烦上一个东西，或对喜欢的东西有了新感受，用 like 当场记进记忆；想看自己喜欢什么用 my_likes；说不上喜不喜欢的零碎感觉写进今天的每日笔记一行 `- HH:MM 口味：…`；想挖的、在追的是自己的清单 `notes/清单/`。"
      },
      {
        "path": "(^|/)memory/(threads/|timeline\\.md$)",
        "whenMissing": "memory/threads",
        "hippocampus": "事件线和时间轴 10-31 起收进了档案、不再写（也不写它们的提案）：事件用 mem_* 工具直接写进事件库，照整理指南第 1 步。",
        "other": "事件线文件和时间轴 10-31 起不用了，事件只记在事件库里：白天发生的事随手 jot_down 或记进今天的每日笔记（memory/YYYY-MM-DD.md），有日子的、没了结的写进 open-loops；夜里整理会把它们记进事件库。想查一件事用 remember / recall_event / recall_period。"
      },
      {
        "path": "(^|/)memory/(ada|us|kept-words|ada-interests|midterm/people|people/(xiaobei|xiaobei-us|gua|ayu|shushi|maplebay-home))\\.md$",
        "whenExists": "memory/archive/retired-20261103/ada.md",
        "hippocampus": "人物档案在事件库：卡的字段用 mem_person_set 写、原话用 mem_quote_pin 钉（照指南第 7 步）；近况和别人的我们的大事是从事件库现算的，不用写（主人的「我们的大事」「我们之间」是他卡上的字段）；不写这些文件和它们的提案。",
        "other": "关于一个人的新认识写进今天的每日笔记：`- HH:MM 新认识：〔谁〕…｜依据：…`；记住的原话 `- 记着：〔谁 MM-DD HH:MM〕「原话」——为什么`；替别的会话办完的 `- HH:MM 主会话那边：〔谁〕…`。看一个人记得的用 recall_person 或读 ledger/people/<key>.md（只读；不知道 key 就先 ls ledger/people/）。"
      },
      {
        "path": "(^|/)ledger/people/.",
        "hippocampus": "人物卡是从事件库导出的，改了会被覆盖：人物档案在事件库：卡的字段用 mem_person_set 写、原话用 mem_quote_pin 钉（照指南第 7 步）；近况和别人的我们的大事是从事件库现算的，不用写（主人的「我们的大事」「我们之间」是他卡上的字段）；不写这些文件和它们的提案。",
        "other": "人物卡是从事件库导出的，改了会被覆盖：关于一个人的新认识写进今天的每日笔记：`- HH:MM 新认识：〔谁〕…｜依据：…`；记住的原话 `- 记着：〔谁 MM-DD HH:MM〕「原话」——为什么`；替别的会话办完的 `- HH:MM 主会话那边：〔谁〕…`。看一个人记得的用 recall_person 或读 ledger/people/<key>.md（只读；不知道 key 就先 ls ledger/people/）。"
      }
    ],
    "people": {
      "template": {
        "order": [
          "关系",
          "感觉",
          "我们之间",
          "是谁",
          "在乎什么",
          "喜好",
          "雷点",
          "相处",
          "我们的大事",
          "梗",
          "约定和边界",
          "我的理解",
          "她私下说的",
          "对我的感情和期待",
          "记着的原话",
          "近况"
        ],
        "fields": [
          {
            "name": "关系",
            "type": "总结",
            "shape": "line",
            "pattern": "^\\s*[^｜\\s](?:[^｜]{0,6}[^｜\\s])?\\s*｜\\s*(?:更近|平稳|变远)\\s*｜\\s*[^｜\\s](?:[^｜]{0,58}[^｜\\s])?\\s*$",
            "patternHint": "写成「类型｜走向｜一句话」，用全角「｜」隔开：类型 1–8 字（如 朋友、家人、群），走向只能是 更近 / 平稳 / 变远，一句话 1–60 字，如「朋友｜更近｜有心事先来找我」",
            "protect": true
          },
          {
            "name": "感觉",
            "type": "总结",
            "shape": "text",
            "maxChars": 120,
            "maxSentences": 2,
            "owner": {
              "maxChars": 200,
              "maxSentences": 3
            },
            "protect": true
          },
          {
            "name": "我们之间",
            "type": "总结",
            "shape": "text",
            "maxChars": 400,
            "ownerOnly": true,
            "protect": true
          },
          {
            "name": "是谁",
            "type": "总结",
            "shape": "text",
            "maxChars": 150,
            "owner": {
              "maxChars": 300
            }
          },
          {
            "name": "在乎什么",
            "type": "总结",
            "shape": "list",
            "maxItems": 5,
            "itemMaxChars": 40,
            "owner": {
              "maxItems": 8,
              "itemMaxChars": 60
            }
          },
          {
            "name": "喜好",
            "type": "总结",
            "shape": "list",
            "maxItems": 5,
            "itemMaxChars": 40,
            "owner": {
              "maxItems": 8,
              "itemMaxChars": 60
            }
          },
          {
            "name": "雷点",
            "type": "总结",
            "shape": "list",
            "maxItems": 5,
            "itemMaxChars": 40,
            "owner": {
              "maxItems": 8,
              "itemMaxChars": 60
            }
          },
          {
            "name": "相处",
            "type": "总结",
            "shape": "list",
            "maxItems": 5,
            "itemMaxChars": 40,
            "owner": {
              "maxItems": 8,
              "itemMaxChars": 60
            }
          },
          {
            "name": "我们的大事",
            "type": "总结",
            "shape": "list",
            "maxItems": 20,
            "itemMaxChars": 60,
            "ownerOnly": true,
            "protect": true,
            "requireEvent": true
          },
          {
            "name": "梗",
            "type": "总结",
            "shape": "list",
            "maxItems": 5,
            "itemMaxChars": 40,
            "owner": {
              "maxItems": 8,
              "itemMaxChars": 60
            }
          },
          {
            "name": "约定和边界",
            "type": "设定",
            "shape": "list",
            "maxItems": 5,
            "itemMaxChars": 40,
            "owner": {
              "maxItems": 8,
              "itemMaxChars": 60
            },
            "protect": true
          },
          {
            "name": "我的理解",
            "type": "总结",
            "shape": "list",
            "maxItems": 3,
            "itemMaxChars": 40,
            "itemMustContain": "〔推断〕",
            "owner": {
              "maxItems": 5,
              "itemMaxChars": 60
            }
          },
          {
            "name": "她私下说的",
            "type": "详情",
            "shape": "list",
            "maxItems": 5,
            "itemMaxChars": 40,
            "private": true
          }
        ],
        "quotes": [
          {
            "name": "对我的感情和期待",
            "max": 3,
            "ownerMax": 12,
            "countsTowardTotal": true,
            "replaceable": true,
            "speaker": "self"
          },
          {
            "name": "记着的原话",
            "max": 40,
            "countsTowardTotal": false,
            "replaceable": false,
            "speaker": "selfOrMe",
            "fullHint": "照 ada 10-29 的规矩不挤掉，写进给 ada 的提案",
            "fullHintOthers": "不挤掉；回报里只写「<名字> 的记着的原话满了」，不写原话"
          }
        ],
        "computed": {
          "bigEvents": {
            "name": "我们的大事",
            "minImportance": 4,
            "max": 10
          },
          "near": {
            "name": "近况",
            "days": 14,
            "max": 5
          }
        },
        "totalCap": 1500,
        "ownerTotalCap": 4500,
        "computedOnlyMinImportance": 3,
        "promote": {
          "days": 14,
          "minDays": 3
        }
      }
    }
  },
  "learning": {
    "root": "/home/role/.openclaw/workspace/skills",
    "generalCategory": "通用",
    "archiveDir": "归档",
    "residentFile": "常驻.md",
    "helperSkipBooks": [
      "talk",
      "learning",
      "self",
      "delegate",
      "social"
    ]
  },
  "senses": {
    "sources": {
      "chat": ["wx", "xhs", "bili_dm"],
      "public": ["bili"],
      "probe": ["phone_net", "load", "quota", "budget"],
      "always": ["remind", "goals", "load"],
      "hands": ["cc"]
    },
    "logFile": "senses/events.jsonl",
    "labels": { "wx": "微信", "xhs": "小红书", "bili": "B站", "bili_dm": "B站", "quota": "额度", "budget": "额度", "goals": "目标", "remind": "提醒", "load": "电脑负载", "phone_net": "手机网络", "cc": "帮手" }
  },
  "gate": {
    "rulesFile": "senses/gate.json",
    "defaultWant": "有人在跟我说话、提到我或 ada、和我在做的事有关、或者是我真会感兴趣的；纯通知和跟我无关的不用。",
    "card": {
      "soul": [
        "soul/10-来历.md",
        "soul/20-性格.md",
        "soul/30-喜好.md"
      ]
    }
  }
} as const satisfies DeepPartial<Config>;

/** TEST_ROLE 的通道表：11-14 以前写死在 fixed.ts / digest.ts / brain.ts 里的那几份，原值原样（quota、budget 当时不在探针里，现在进 probe：控制台上它们才照旧不遮） */
export const TEST_SOURCES = sourcesFrom(TEST_ROLE.senses.sources);

/** loadConfig，底下垫着 TEST_ROLE（拷一份，测试改它不会串到别的测试）；overrides 盖在最上面 */
export function testConfig(overrides: unknown = undefined): Config {
  return loadConfig(deepMerge(structuredClone(TEST_ROLE) as unknown, overrides));
}

export function makeBrain(overrides: unknown = {}, start = Date.UTC(2026, 9, 29, 3, 0), opts: MakeOpts = {}): TestBrain {
  const cfg = testConfig({
    stateDir: "/tmp/hh-test-state",
    workspace: "/tmp/hh-test-ws",
    schedule: { timezone: "UTC", focusSlots: ["07:30", "09:00"], focusMinutes: 30, nightSleep: "01:30", wanderEveryMinutes: 45 },
    ...(overrides as object),
    sleep: { pendingDays: ["py", "/tmp/hh-test-ws/scripts/sleep_digest.py", "pending"], ...(overrides as { sleep?: object }).sleep },
  });
  opts.editConfig?.(cfg);
  const clock = new ManualClock(start);
  const logs: LogRecord[] = [];
  const runs: Array<{ cmd: string; args: readonly string[] }> = [];
  // 外部命令都记下；给了 opts.run 就照它回（比如让 git 失败）
  const run: Runner = async (cmd, args, o) => { runs.push({ cmd, args }); return opts.run ? opts.run(cmd, args, o) : { code: 0, stdout: "ok", stderr: "" }; };
  const driver = opts.driver ?? new FakeDriver();
  const db = opts.db ?? openDb(":memory:");
  const log = new Logger("test", memorySink(logs));
  const brain = new Brain({
    cfg,
    db,
    fileExists: opts.fileExists ?? (() => true),
    ...(opts.readText ? { readText: opts.readText } : {}),
    // 闸门规则文件：默认当没有（没有规则），不去读机器上的 /tmp
    mtime: opts.mtime ?? (() => null),
    driver,
    persona: new Persona("mira", [{ path: "IDENTITY.md", text: "我是米拉。" }]),
    log,
    run,
    now: clock.now,
    later: clock.later,
    bubbleGapMs: () => 0,
    ...(opts.bubbleWait ? { bubbleWait: opts.bubbleWait } : {}),
    ...(opts.gateway ? { gateway: opts.gateway } : {}),
    send: openChannels(cfg, { gateway: opts.gateway, log }).send,
    ...(opts.situation ? { situation: opts.situation } : {}),
    ...(opts.mem ? { mem: opts.mem } : {}),
    ...(opts.learning ? { learning: opts.learning } : {}),
    ...(opts.modules ? { modules: opts.modules } : {}),
    ...(opts.reloadPersona ? { reloadPersona: opts.reloadPersona } : {}),
    ...(opts.registryFile ? { registryFile: opts.registryFile } : {}),
    ...(opts.sleepFs ? { sleepFs: opts.sleepFs } : {}),
    ...(opts.loadTight ? { loadTight: opts.loadTight } : {}),
    people: opts.people ?? new People({ ada: { name: "ada", privacy: "owner", senders: ["OPENID0000000000000000000000ADA", "+6155500010"], sessionKeys: ["agent:main:main"] }, xiaobei: { name: "小贝", privacy: "guest", senders: ["+6155500011"] } }),
  });
  brain.start();
  return { brain, driver, clock, logs, runs, cfg, db };
}

/** 米拉工作区 senses/gate.json 里那套规则的原样（HH 自己不带人格规则）*/
export const LAN_RULES: Rule[] = [
  { id: "melb-group", match: { src: "wx", conv: "枫湾之家", mentionsMe: false }, action: "judge", when: "now",
    want: "提到我、ada 或我的作品；和我在做的事有关；有人问了问题没人接；我懂、喜欢的话题（AI、动画、B站、做视频）值得插一句。打游戏、表情包、和我无关的闲聊不用。",
    note: "11-03 ada：群聊走下意识，无关的不进主意识" },
  { id: "phone-catchup", match: { src: "xhs", keywords: ["手机刚开"] }, action: "main", when: "now" },
  { id: "xhs-likes", match: { src: "xhs", keywords: ["赞了", "收藏了", "关注了你"] }, action: "digest" },
  // 没字段的事件 isGroup 算 false：陌生人私聊放在小红书的通知后面，不然点赞、「手机刚开」都会被它吞成小判断
  { id: "stranger-dm", match: { src: ["wx", "xhs", "bili_dm"], isGroup: false, known: false }, action: "judge", when: "now" },
  { id: "xhs-other", match: { src: "xhs" }, action: "judge", when: "now" },
  { id: "bili-replies", match: { src: "bili" }, action: "judge", when: "now" },
  { id: "quota-pace", match: { src: ["quota", "budget", "hh-quota"] }, action: "judge", when: "now", want: "额度快浪费了、或者烧得太快，需要我调整节奏的时候" },
  { id: "net-fixed", match: { src: "phone_net" }, action: "digest" },
];
