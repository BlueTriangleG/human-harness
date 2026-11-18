# English glossary

The English packs (`src/lang/en`, `src/console/lang/en`, `modules/*/texts.json`, the English manuals) translate the
Chinese ones. Use this table when you write or change English text, so that one thing keeps one name everywhere.
The Chinese column is the reference wording; "not" lists names to avoid for the same thing.

## People

| Chinese | English | Notes |
|---|---|---|
| 角色 | the role | Never `she`/`he`/`her` for the role: write `{{me}}` (`{me}` in module texts). A Chinese entry that says 她 still gets `{{me}}` in English. `{{ta}}` is the role's own pronoun from its config and may fall back to its name, so `{{ta}}'s` is not safe. |
| 主人 | `{{owner}}`; else *your owner* (to the role), *the owner* (in manuals), *my owner* (in the role's own first-person text) | Not *master*, not *he*/*his*: repeat `{{owner}}` or use *they*. |
| 访客 | guest | Not *visitor*. |
| 认识的人、名单 | the people you know; the people list | `people_i_know` |
| 帮手 | helper | A Claude Code session working in the background (`helper` command, `hands` tool). Not *worker* in text the role reads. |
| 子代理 | sub-agent | |
| 会话 | session | |

## The brain

| Chinese | English | Notes |
|---|---|---|
| 脑区 | (brain) region | |
| 前额叶 | Main (console); the prefrontal cortex (when it coordinates the night) | Not *the prefrontal* on its own. |
| 支线、一边做 | side task; *alongside* (`go on alongside`) | |
| 快答 | quick reply | |
| 海马 | hippocampus (role text); Consolidation (console region name) | |
| 慢慢想 | mull over; mulling | |
| 下意识 | the subconscious | |
| 闸门 | the gate | |
| 小判断、快判 | the quick judge | Not *the small judging*. |
| 感官、感知层 | the senses | Not *the perception layer*, *the sense layer*. |
| 动静 | something new came in; an event | |

## Memory

| Chinese | English | Notes |
|---|---|---|
| 中央记忆 | central memory | Its entries: *record*, `#N` = record number. |
| 原话 | original words; *own words* when it is whose words they are | 原话层 = the layer of original words. |
| 翻页 | page turn | |
| 压缩、压缩记忆 | compaction; compacted memory | |
| 中期视图、中期记忆 | midterm view; midterm memory | Not *mid-term*. |
| 事件库 | event store | *event memory* in the console. |
| 事件 | event (stores, ids); matter (in tools the role uses) | |
| 经过 | passage (one entry); timeline (all of them) | The night scripts' files keep the Chinese heading 经过. |
| 人物卡 | person card | |
| 睡眠整理、夜里整理 | (the night's) consolidation; consolidate | Not *tidying*, *organizing*. The one doing it: *the consolidating session*. |
| 老整理 | the old consolidation (the night scripts) | As against the new sleep engine. |
| 回放 | replay | |
| 回测 | back-test | Not *replay test*. |
| 体检 | memory check-up | |
| 考题、判分 | exam questions; grading | 标准答案 = gold answer / standard answer. |

## Learning and work

| Chinese | English | Notes |
|---|---|---|
| 笔记本、书架、页、封面 | notebook, shelf, page, cover | |
| 做法 | way of doing things; practice (in page headings) | |
| 教训 | lesson | |
| 联想 | association; *bring up* a page | |
| 常驻 | always-present (the list); resident (the exam layer) | |
| 把关 | the check | |
| 标准（做到什么样才算好） | the bar | `set_bar` |
| 回头看 | look back (over) | |
| 卡住 | stuck | |
| 交回、交出去 | hand back; hand over | |
| 待办账本、待办 | the to-do ledger; to-dos | The night scripts' file is open-loops.md: *open loops* there. |
| 专注 | focus | |
| 放空 | idle time; let your mind wander | |
| 夜里放空 | night rest | |

## Machine and channels

| Chinese | English | Notes |
|---|---|---|
| 额度 | quota | 5-hour window, 7-day window. *usage* in the console's charts; *budget* for the gate's own allowance. |
| 负载把关 | the load guard | `load` |
| 巡检 | patrol | |
| 减负 | shed load | |
| 余量 | room | |
| 看门狗 | watchdog | |
| 通道、桥 | channel; bridge | |
| 修理、毛病本 | repair; the fault book | The file keeps its name, 毛病本.md. |
| B站、UP主、弹幕 | Bilibili; uploader; bullet comments | Not *B站*, not *danmaku* (except tool names such as `send_danmaku`). |
| 小红书 | Xiaohongshu | |

## Style

- Plain sentences. Say what to do, then why, as the Chinese does.
- Straight quotes (`"…"`) in English. Times as `04:00`, not *4 o'clock*.
- A placeholder (`{{me}}`, `{{owner}}`, `{owner}`, `%s`, `⟨n⟩` holes) stays exactly as the Chinese entry has it; adding `{{me}}`
  where the Chinese has 她 is the one exception.
- Do not translate a word that code or a test reads. These stay in Chinese or in Chinese punctuation on purpose, each
  with its reason at the top of its file or in `test/lang-forms.kept.json` / `test/sleep-text.kept.json`:
  the sense header `[感官]` and the `·要你处理` tag; full-width brackets the model is told to write and code parses
  (`（#N）`, `〔…〕`, `〔锚：…〕`, `｜`); the repair marks 红 / 看, the trailer word 通过 and 毛病本.md; the commit
  subject 睡眠整理 <day>; the night scripts' section names of the role's files (经过, 因果, 拿不准, …) and the 「…」 quotes
  around them.
- Before you change a Chinese mark in an English entry, find what reads it.
