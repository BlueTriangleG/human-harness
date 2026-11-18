// The Chinese pack's learning text: what the role reads from the learning code (the per-turn associations, the entry reminders, the night's worksheet and the weekly report, the heading of the pinned pages).
// Code under src/learning/ reads it through L (see src/lang/index.ts).
// The rules of every pack file apply: the text is moved character for character; a literal without ${} keeps its
// kind, one with ${} becomes an arrow function whose body is the template; plain identifier keys; no runtime
// import here (import type only); text that code matches against (a token) does not belong here.
// A language pack is one per language, shared by every role of that language: nothing of one role (a name, a
// channel, a file name, a path) goes in here — that is instance configuration, passed into a sentence as a parameter.

/** 强联想那一行括号里，主人当时的原话（notebook.ts 的 pageItems） */
export const ownerQuote = (owner: string, quote: string): string => `${owner}：「${quote}」`;

/** 每周数字里被主人纠正的那一行（score.ts 的 renderWeekly） */
export const weeklyCorrections = (owner: string, corrections: number): string => `- 被 ${owner} 纠正：${corrections} 次`;

/** 夜里工作单里主人的纠正那一节的标题（score.ts 的 worklist） */
export const worklistCorrectionsTitle = (owner: string): string => `今天 ${owner} 的纠正`;

/** 工作单「强度」一节：常驻着这一天还犯了的教训（score.ts 的 strengthList）；who 是教训和它的出处 */
export const residentStillRecurs = (who: string, owner: string): string =>
  `- ${who}：常驻着今天还犯了：光提醒不够，想想能不能做成机制（工具、HH 拦住），记进毛病本交 ${owner}`;

/** 前缀里常驻单子的开头（shelf.ts 的 renderResident）；path 是她的单子相对工作区的路径 */
export const residentHeader = (path: string): string => `# 常驻：我老犯的（每一轮都记着；单子在 ${path}，按最近最需要的自己换）`;

// src/learning/associate.ts
export const associate = {
  // ---- headers of the mounted notes ----
  header: "想起来的笔记（用得上就翻开）：",
  onItHeader: "这件事以前做过类似的，动手前先翻开这几页（联想不一定准，翻开核一下）：",
  practiceHeader: "  先照这几条做：",
  hitsHeader: "  对得上的：",
  maybeHeader: "  可能有关（不一定准，翻开核一下）：",
  loudHeader: "⚠️ 老毛病，这次别再犯（动手前先在心里写一句「这次我会……」，照着做）：",
  helperHeader: "（我笔记里跟这件事有关的页，动手前先读一遍，里面的做法和踩过的坑照着来：）",
  carryHeader: (task: unknown) => `上次做「${task}」时翻过：`,
  // ---- questions put to the judge ----
  judgeInput: (topic: unknown) => `{{ta}}正要回应或开始做：${topic}\n每题问：这件事需要翻这一页笔记吗？只有正好讲这类事的做法或教训才算。`,
  pageQuestion: (cover: unknown) => `需要翻「${cover}」吗？`,
  itemQuestion: (kind: unknown, item: unknown) => `这件事正好用得上这条${kind}吗？「${item}」`,
  kindLesson: "教训",
  kindPractice: "做法",
  stepQuestion: (situation: unknown) => `{{ta}}接下来这一步就要碰上「${situation}」这个情形吗？只凭上面写出来的判断，看不出来就答否；只是在做沾边的事不算，要看得出这一步就要这么做。`,
  sentQuestion: (lesson: unknown) => `{{ta}}这次要发出去的这条里，是不是正好又犯了这条：「${lesson}」？只凭上面写出来的判断，看不出来就答否；只是跟这条沾边、没犯的不算。`,
  // ---- page lines ----
  coverLessonCount: (count: unknown) => `${count} 条教训；`,
  coverEntry: (book: unknown, title: unknown, brief: unknown, lessonCount: unknown, shelfDir: unknown, path: unknown) => `· ${book} · ${title}：${brief}（${lessonCount}${shelfDir}/${path}）`,
  helperPageLine: (path: unknown, brief: unknown) => `- ${path}：${brief}`,
};

// src/learning/cli.ts
export const cli = {
  // ---- hh learn scan ----
  scanSummary: (books: unknown, pages: unknown, archivedPages: unknown, lessons: unknown, newCovers: unknown) => `书架：${books} 本，${pages} 页（另有归档 ${archivedPages} 页），${lessons} 条教训；封面新算了 ${newCovers} 页`,
  problemsHeader: (count: unknown) => `问题（${count}）：`,
  // ---- hh learn replay ----
  replayDisabled: "learning.enabled 关着，回测没跑",
  replayUnjudged: (count: unknown) => `，没判成 ${count} 道`,
  replayNeverRan: "—（没跑过）",
  replaySummary: (night: unknown, total: unknown, passed: unknown, unjudged: unknown, previousPassed: unknown) => `回测（${night}）：${total} 道里过了 ${passed} 道${unjudged}；前一晚过了 ${previousPassed}`,
  // ---- usage and unknown actions ----
  helperUsage: "用法：hh learn helper <帮手名> <活…>",
  unknownAction: (action: unknown) => `hh learn 不认识：${action}（scan stats week replay ids format case migrate-check helper param links near graph）`,
  statsUsage: "用法：hh learn stats [天数]",
  // ---- hh learn links, near, graph ----
  pageName: (title: unknown, id: unknown, path: unknown) => `${title}（${id}，${path}）`,
  pageArgUsage: (action: unknown) => `用法：hh learn ${action} <页的编号、文件名或标题>`,
  pageNotFound: (query: unknown) => `书架上找不到这一页（或者不止一页叫这个名字，写上路径）：${query}`,
  linkKindRef: "页里提到",
  linkKindCo: "一起翻过",
  linkKindEvent: "同一件事里写到",
  noLinks: (page: unknown) => `${page}：还没有连线`,
  linkCount: (count: unknown) => ` ${count} 次`,
  linkLine: (direction: unknown, page: unknown, kind: unknown, count: unknown) => `${direction} ${page}｜${kind}${count}`,
  noNeighbours: (page: unknown) => `${page}：还没有相邻的页`,
  kindSeparator: "、",
  neighbourLine: (page: unknown, kinds: unknown) => `- ${page}｜${kinds}`,
  graphSummary: (pages: unknown, shallow: unknown, mid: unknown, deep: unknown, links: unknown, unlinked: unknown) => `${pages} 页：浅 ${shallow}、中 ${mid}、深 ${deep}；${links} 条线，没有线的页 ${unlinked} 页`,
  neverOpened: "从没翻过",
  daysUnopened: (days: unknown) => `${days} 天没翻`,
  deepPageLine: (path: unknown, idle: unknown) => `- 深：${path}（${idle}）`,
  graphJsonHint: "（--json 出整张图的数据）",
  // ---- hh learn param ----
  paramOverridden: (base: unknown) => `改过；默认 ${base}`,
  paramFollowsConfig: "跟着配置",
  paramIsDefault: "默认",
  paramLine: (name: unknown, value: unknown, source: unknown, min: unknown, max: unknown, step: unknown, description: unknown) => `${name} = ${value}（${source}；${min}–${max}，一步 ${step}）${description}`,
  paramUnknown: (name: unknown, known: unknown) => `参数不认识：${name}（${known}）`,
  paramNeedsNumber: (name: unknown) => `${name}：要给一个数（或「默认」）`,
  paramManualReason: "手动改",
  paramDefaultValue: (value: unknown) => `默认（${value}）`,
  paramChanged: (name: unknown, before: unknown, after: unknown) => `${name}：${before} → ${after}`,
  // ---- hh learn migrate-check ----
  migrateUsage: "用法：hh learn migrate-check <lessons.md 路径> <归档目录>（相对路径从工作区算）",
  migrateUnreadable: (path: unknown, error: unknown) => `读不了 ${path}（${error}）`,
  migrateMissingHeader: (missing: unknown, total: unknown) => `没在笔记页里找到的教训（${missing} 条，共 ${total} 条）：`,
  migrateAllPresent: "都在",
  migrateShelfProblems: (count: unknown) => `书架的问题（${count}）：`,
  migrateDirUnreadable: (path: unknown, error: unknown) => `${path}：读不了目录（${error}）`,
  migrateArchiveUnreadable: (path: unknown, error: unknown) => `归档目录读不了：${path}（${error}）`,
  migrateFileUnreadable: (path: unknown) => `${path}：读不了`,
  migrateLinesLeft: (path: unknown, count: unknown) => `${path}：${count} 行没搬进新页（在归档里）`,
  // ---- hh learn case ----
  caseAddUsage: "用法：hh learn case add <页编号> <话题…>",
  caseUnknownId: (id: unknown) => `不认识 ${id} 这个编号（hh learn ids 列出认得的）`,
  caseNotPage: (id: unknown) => `${id} 不是页（是一条教训），题要的是页编号`,
  caseAdded: (number: unknown, topic: unknown, pageId: unknown) => `加了第 ${number} 题：${topic} → ${pageId}`,
  caseNone: "（还没有题）",
  caseUnknownAction: (action: unknown) => `hh learn case 不认识：${action}（add ls）`,
};

// src/learning/curator.ts
export const curator = {
  // ---- layers section of the night report ----
  sectionTitle: (shallow: unknown, mid: unknown, deep: unknown) => `## 笔记分层（浅 ${shallow} 页、中 ${mid} 页、深 ${deep} 页）`,
  sunkHeader: "### 今晚沉到深层的页（不挪、不删；现在只是记下层，联想照旧会带它；看看有没有沉错的）",
  quietImportantHeader: "### 重要、但很久没翻的页（重要的不沉；看看封面要不要改）",
  // ---- page lines ----
  pageLine: (path: unknown, idle: unknown, importance: unknown) => `- ${path}：${idle}，重要度 ${importance}`,
  neverOpened: (graceDays: unknown) => `从没翻过（算上宽限 ${graceDays} 天）`,
  daysUnopened: (days: unknown) => `${days} 天没翻`,
};

// src/learning/decisions.ts
export const decisions = {
  // ---- daily spending cap ----
  dailyCapReached: "已到当天费用上限",
  dailyCapAlert: (spentUsd: unknown, limitUsd: unknown) => `联想的判断今天用到上限了（${spentUsd} 美元，上限 ${limitUsd} 美元），今天不再判断，明天恢复。`,
  // ---- circuit breaker ----
  breakerAlert: (rounds: unknown, lastError: unknown) => `联想的判断服务连续熔断了 ${rounds} 轮（约 30 分钟都没通），最近的错误：${lastError}`,
};

// src/learning/layers.ts
export const layers = {
  // ---- shelf rules file problems ----
  rulesMissing: (file: unknown) => `书架的规矩文件 ${file} 没有或读不了：没有「算重要」的记号，重要度只看常驻、教训强度和页开头的 importance`,
  rulesNotObject: "不是一个对象",
  rulesUnreadable: (file: unknown, error: unknown) => `书架的规矩文件 ${file} 读不懂（${error}）：这次按没有记号算`,
};

// src/learning/notebook.ts
export const notebook = {
  // ---- practice items ----
  keptMark: (mark: unknown) => `（${mark}）`,
  practiceWithHow: (practice: unknown, how: unknown) => `${practice}：${how}`,
  unverifiedPractice: (practice: unknown) => `（待验证）${practice}`,
  practiceAsk: (title: unknown, practice: unknown) => `${title}：${practice}`,
  practiceLoudLine: (practice: unknown, shelfDir: unknown, path: unknown) => `${practice}〔${shelfDir}/${path}〕`,
  // ---- lesson items ----
  lessonField: (text: unknown) => `教训：${text}`,
  whenField: (when: unknown) => `什么时候：${when}`,
  nextField: (next: unknown) => `下次：${next}`,
  doneField: (done: unknown) => `怎样算做到：${done}`,
  askWhenPrefix: (when: unknown) => `${when}：`,
  askNextSuffix: (next: unknown) => `——下次：${next}`,
  lineNextWithLast: (next: unknown, what: unknown) => `${next}（上次：${what}）`,
  lineLesson: (what: unknown) => `教训：${what}`,
  loudLesson: (what: unknown) => `教训：${what}`,
  loudLine: (text: unknown, why: unknown, shelfDir: unknown, path: unknown) => `${text}（${why}）〔${shelfDir}/${path}〕`,
  lastTime: (what: unknown) => `上次：${what}`,
  recurCount: (count: unknown, lastDay: unknown) => `犯过 ${count} 次，最近 ${lastDay}`,
  // ---- cover ----
  coverText: (book: unknown, title: unknown, brief: unknown, when: unknown) => `${book} · ${title}：${brief}（什么时候翻：${when}）`,
  // ---- scan problems ----
  shelfUnreadable: (root: unknown, error: unknown) => `读不了书架目录 ${root}（${error}）`,
  categoryUnreadable: (category: unknown, error: unknown) => `${category}：读不了目录（${error}）`,
  dirUnreadable: (path: unknown, error: unknown) => `${path}：读不了目录（${error}）`,
  skillFileUnreadable: (category: unknown, book: unknown, error: unknown) => `${category}/${book}/SKILL.md：读不了（${error}）`,
  bookWithoutSkill: (category: unknown, book: unknown) => `${category}/${book}：没有 SKILL.md，这本不算，里面的页也不进联想`,
  archivedPageUnreadable: (path: unknown, error: unknown) => `${path}：读不了（${error}）`,
  pageUnreadable: (path: unknown, error: unknown) => `${path}：读不了（${error}）`,
  missingBrief: (path: unknown) => `${path}：缺「简介」`,
  missingWhen: (path: unknown) => `${path}：缺「什么时候翻」`,
  duplicateId: (prefix: unknown, id: unknown, paths: unknown) => `编号 ${prefix}:${id} 重复，出现在：${paths}`,
  pathSeparator: "、",
};

// src/learning/params.ts
export const params = {
  // ---- parameter descriptions: strength ----
  descStrengthWindowDays: "算又犯看最近几天",
  descStrengthStrongDays: "窗口里犯了几天 → 至少强联想（4）",
  descStrengthResidentDays: "窗口里犯了几天 → 常驻候选（5）",
  descStrengthCalmDays: "4 级以上多少天没犯 → 降一级（不低于 3）",
  descStrengthResidentMax: "常驻单子最多几条",
  descStrengthStrongMin: "强度到几算强联想（3 是没写强度的默认，不能算强）",
  descStrengthStrongThreshold: "强联想条目过线的概率",
  descStrengthStrongRemountTokens: "有强联想条目的页，挂过以后又看了多少 token 就能再挂",
  descStrengthStrongAsk: "强联想条目每次最多问几条（不管像不像）",
  descStrengthHandRemountTokens: "交之前、发给主人之前，有强条目的页这个脑区自己又看了多少 token 才再贴（0 = 每次都贴）",
  descStrengthDailyMax: "同一条强教训 24 小时里按强联想最多贴几次；够了以后要过普通条目的门槛才贴、不再单列（0 = 不限；发给主人之前那道核对不算）",
  // ---- parameter descriptions: assoc ----
  descAssocThreshold: "页和条目过线的概率（主人的纠正题照旧用 learning.threshold）",
  descAssocItemsK: "按向量挑几条条目和页一起问",
  descAssocKWake: "叫醒时按封面向量先挑几页进判断（默认 learning.kWake）",
  descAssocKTask: "开始做、干活中、交之前、发之前按封面向量先挑几页进判断（默认 learning.kTask）",
  descAssocGeneralExtra: "通用类的页没进前 k 的，额外补几页（以前是全补，占了一半题数、几乎挂不上）",
  descAssocReuseCos: "话题向量和这个脑区上一次的余弦到这么多，就照用上次的判断（1 = 不照用）",
  descAssocReuseMin: "照用上次判断，最多隔几分钟",
  descAssocCarryCos: "开始做时，和最近哪次开始做的话题向量余弦到这么多算同一件事接着做，把那时翻过的页带上（1.01 = 不带）",
  descAssocCarryDays: "同一件事接着做：往回找几天",
  descAssocCarryMax: "同一件事接着做：最多带上几页",
  descAssocHitsPerPage: "一页最多贴几条对得上的",
  descAssocRemountTokens: "干活的时刻，挂过的页又看了多少 token 能再挂（默认 learning.remountTokens）",
  descAssocFullTextAt: "判断把握到这么多，条目直接给原文、开始做时贴做法头几条；不到就只给一句大概，让她翻开核一下（1.01 = 一律只给大概）",
  descAssocStepThreshold: "标了「提醒：动手时」的条目，「这一步就要做吗」那一问要过多少才算对得上",
  descAssocSaveAt: "当天判断的花费到上限的多少，就先停干活途中（midwork）的联想",
  // ---- parameter descriptions: layers and links ----
  descLayersDeepDays: "不重要的页多少天没翻沉到深层；翻开次数也按最近这么多天数",
  descLayersGraceDays: "从没翻过的页，第一次扫到以后先宽限这么多天再起算",
  descLayersShallowOpens: "最近 deepDays 天里有这么多天翻开过算常翻，放浅层",
  descLinksCoGapMin: "同一件事里，两次翻开相隔不超过这么多分钟才算一起翻（learn_link 的 co 线；事开得久时，隔了半天翻的两页不连）",
  // ---- parameter descriptions: midwork ----
  descMidworkMinMin: "干活时联想两次之间至少隔几分钟",
  descMidworkEveryMin: "隔了几分钟（或者用了 everyTools 次工具）手上这一步变了就再联想",
  descMidworkEveryTools: "用了几次工具（或者隔了 everyMin 分钟）手上这一步变了就再联想",
  descMidworkUnreadTools: "开始做时挂了笔记、她用了这么多次工具还一页没翻，就提醒一次（主人 11-04：做过类似的先翻笔记）",
  // ---- parameter descriptions: handover ----
  descHandoverMinChars: "一条发给主人的字数到这么多算交东西（带图、文件的都算）",
  descHandoverBurstChars: "三分钟里连着发给主人的字数加起来到这么多也算（稿子常是一段一条地贴）",
  descHandoverSentAt: "标了「提醒：发之前」的强教训，「这条里正好又犯了吗」那一问要过多少才拦（1.01 = 先只问、记进 asked，不看它）",
  descHandoverGraceMin: "拦过一次以后几分钟内照发、不再拦",
  // ---- errors ----
  unknownParam: (name: unknown) => `参数不认识：${name}`,
  needsConfigValue: (name: unknown) => `参数 ${name} 跟着配置，调用时要给配置里的值`,
  unknownParamWithList: (name: unknown, known: unknown) => `参数不认识：${name}（${known}）`,
  notANumber: (name: unknown, value: unknown) => `${name}：${value} 不是数`,
  outOfRange: (name: unknown, value: unknown, min: unknown, max: unknown) => `${name}：${value} 超出上下限 ${min}–${max}`,
};

// src/learning/runtime.ts
export const runtime = {
  // ---- replay lines of the night report ----
  replayTonight: (passed: unknown, total: unknown, unjudged: unknown) => `- 今晚回测：通过 ${passed}/${total}${unjudged}`,
  replayUnjudged: (count: unknown) => `（没判成 ${count} 道）`,
  replayNoResult: "- 今晚回测：没有结果",
  tonightUnjudged: (count: unknown) => `- 回测这晚有 ${count} 道没判成，不比较`,
  previousUnjudged: (count: unknown) => `- 回测前一晚有 ${count} 道没判成，不比较`,
  passRateDropped: (previous: unknown, current: unknown) => `回测通过率比昨晚低：${previous} → ${current}\n`,
  passRate: (percent: unknown, passed: unknown, total: unknown) => `${percent}%（${passed}/${total}）`,
};

// src/learning/score.ts
export const score = {
  // ---- weekly numbers ----
  weeklyTitle: "# 最近 7 天的学习",
  weeklyNewLessons: (count: unknown) => `- 新教训：${count} 条`,
  weeklyRecur: (total: unknown, mounted: unknown, unmounted: unknown) => `- 又犯：${total} 次（挂了还犯 ${mounted}，没挂就犯 ${unmounted}）`,
  weeklyCatchRate: (value: unknown) => `- 接住率：${value}`,
  weeklyCatchValue: (rate: unknown, mounts: unknown, opened: unknown) => `${rate}（挂了 ${mounts} 页，翻开 ${opened} 页）`,
  weeklyNoMounts: "这几天没挂过",
  weeklyIdleMounts: (count: unknown) => `- 白挂（挂了没翻）：${count} 次`,
  weeklyPromoted: (count: unknown) => `- 待验证升级成靠谱：${count} 条`,
  weeklyEstimate: (value: unknown) => `- 估时间的准头：${value}`,
  weeklyEstimateTooFew: "做完的事不到 3 件，还算不出",
  weeklyEstimateValue: (ratio: unknown) => `实际是估的 ${ratio} 倍（最近 10 件做完的事）`,
  weeklyReplay: (value: unknown) => `- 回测通过率：${value}`,
  weeklyReplayNeverRan: "这几天还没跑过",
  weeklyReplayValue: (rate: unknown) => `${rate}（最近一晚）`,
  // ---- worksheet: title and section titles ----
  worklistTitle: (day: unknown) => `# 学习工作单 ${day}`,
  titleIdleToday: "今天挂了没翻的页",
  titleUnreadDone: "开始做时提过、没翻就做完了",
  titleRecurUnmounted: "今天又犯、当时没想起来的",
  titleRecurMounted: "想起来了还是又犯的",
  titleDone: "做成的事",
  titleRecurLong: "同一条犯了 3 天以上的",
  titleStrength: "强度（升降建议）",
  titlePrune: "删减和降级",
  titleDuplicates: "可能重复的",
  none: "（没有）",
  badDay: "日期要写成 YYYY-MM-DD，比如 2026-11-01",
  // ---- worksheet: how a page or lesson is referred to ----
  pageRef: (book: unknown, title: unknown, shelfDir: unknown, path: unknown) => `${book} · ${title}（${shelfDir}/${path}）`,
  lessonPageRef: (book: unknown, title: unknown, shelfDir: unknown, path: unknown, idSuffix: unknown) => `${book} · ${title}，${shelfDir}/${path}${idSuffix}`,
  lessonRefId: (id: unknown) => `，l:${id}`,
  lessonBrief: (lesson: unknown, book: unknown, title: unknown, idSuffix: unknown) => `${lesson}（${book} · ${title}${idSuffix}）`,
  lessonBriefId: (id: unknown) => `，l:${id}`,
  // ---- worksheet: mounted but not opened ----
  idleLine: (page: unknown, count: unknown, topics: unknown) => `- ${page}：挂了 ${count} 次没翻${topics}`,
  idlePageMissing: (pageId: unknown) => `p:${pageId}（书架上找不到）`,
  idleTopics: (topics: unknown) => `；当时在做：${topics}`,
  unreadLine: (topic: unknown, taskId: unknown, pages: unknown) => `- 「${topic}」（编号 ${taskId}）：开始时提过${pages}，做完一页都没翻`,
  unreadPageTitle: (title: unknown) => `「${title}」`,
  unreadSummary: (suggested: unknown, unread: unknown) => `（这一天做完的事里，开始时提过笔记的 ${suggested} 件，没翻就做完的 ${unread} 件）`,
  // ---- worksheet: lessons that recurred ----
  recurLine: (lesson: unknown, ref: unknown, tail: unknown) => `- ${lesson}（${ref}）${tail}`,
  recurTail: (day: unknown, source: unknown, topic: unknown) => `；${day}${source}${topic}`,
  recurSource: (seq: unknown) => `；出处 #${seq}`,
  recurTopic: (topic: unknown) => `；当时在做：${topic}`,
  recurLongLine: (lesson: unknown, ref: unknown, count: unknown, days: unknown) => `- ${lesson}（${ref}）：犯了 ${count} 天（${days}）`,
  recurDaysSeparator: "、",
  // ---- worksheet: the owner's corrections ----
  correctionLine: (time: unknown, seq: unknown, topic: unknown, task: unknown) => `- ${time}${seq}：${topic}${task}`,
  correctionNoSeq: "（没有消息编号）",
  correctionNoTopic: "没记话题",
  correctionTask: (taskId: unknown) => `（当时手上的事 编号 ${taskId}）`,
  unfiledLine: (month: unknown, day: unknown, hour: unknown, minute: unknown, seq: unknown, topic: unknown) => `- 还没落到笔记上：${month}-${day} ${hour}:${minute} #${seq}：${topic}`,
  unfiledNoTopic: "没记话题",
  // ---- worksheet: what got done ----
  doneLine: (topic: unknown, taskId: unknown, pages: unknown) => `- 「${topic}」（编号 ${taskId}）${pages}`,
  donePages: (titles: unknown) => `；挂过的页：${titles}`,
  doneNoPages: "；没挂过页",
  doneTitleSeparator: "、",
  // ---- worksheet: strength ----
  strengthParams: (window: unknown, strongDays: unknown, residentDays: unknown, calmDays: unknown, residentMax: unknown) => `（参数：看最近 ${window} 天；犯 ${strongDays} 天 → 强度 4，犯 ${residentDays} 天 → 5；4 级以上 ${calmDays} 天没犯降一级；常驻最多 ${residentMax} 条。改参数：hh learn param。写法：那一行加「｜强度：N」）`,
  strengthChange: (who: unknown, from: unknown, to: unknown, reason: unknown) => `- ${who}：${from} → ${to}（${reason}）`,
  strengthWho: (lesson: unknown, ref: unknown) => `${lesson}（${ref}）`,
  strengthRaiseReason: (window: unknown, count: unknown, days: unknown) => `${window} 天里犯了 ${count} 天：${days}`,
  strengthDaysSeparator: "、",
  strengthCalmReason: (days: unknown) => `${days} 天没犯了`,
  strengthAlways: "一直",
  strengthUnlisted: (lessons: unknown) => `- 强度 5、还没进常驻单子：${lessons}`,
  unlistedLesson: (lesson: unknown, id: unknown) => `${lesson}（l:${id}）`,
  strengthStale: (lessons: unknown) => `- 常驻单子里很久没犯的：${lessons}`,
  staleLesson: (lesson: unknown, id: unknown, quiet: unknown) => `${lesson}（l:${id}，${quiet}）`,
  staleQuietDays: (days: unknown) => `${days} 天没犯`,
  staleNoDays: "没记过犯的日子",
  // ---- worksheet: pruning ----
  pruneIdleTitle: (mounts: unknown) => `挂过 ${mounts} 次以上、一次都没翻的页`,
  pruneColdTitle: (days: unknown) => `${days} 天没挂也没翻的页`,
  prunePendingTitle: (days: unknown) => `待验证里 ${days} 天没再用过的条目`,
  pruneLearnedTitle: "学会了的教训",
  pruneIdleLine: (page: unknown, mounts: unknown) => `- ${page}：挂了 ${mounts} 次，一次没翻`,
  prunePendingLine: (page: unknown, item: unknown, date: unknown) => `- ${page}：${item}（日期 ${date}）`,
  pruneLearnedLine: (lesson: unknown, ref: unknown, window: unknown, days: unknown) => `- ${lesson}（${ref}）：这 ${window} 天页被挂了 ${days} 天，这条没再犯`,
  // ---- worksheet: possible duplicates ----
  dupPages: (first: unknown, second: unknown, cosine: unknown) => `- 页：${first} ≈ ${second}（余弦 ${cosine}）`,
  dupLessons: (first: unknown, second: unknown, cosine: unknown) => `- 教训：${first} ≈ ${second}（余弦 ${cosine}）`,
  dupLessonsUnavailable: "- 教训：（今晚算不了）",
};

// src/learning/shelf.ts
export const shelf = {
  // ---- shelf directory in the prefix ----
  header: "# 我的书架\n我的做法和教训都记在这些笔记本里。做事时相关的页会自己冒出来；想找全就用 what_do_i_know，或者直接翻文件。",
  bookLine: (book: unknown, description: unknown, pages: unknown) => `- ${book}：${description}（${pages} 页）`,
};

// src/learning/tuner.ts
export const tuner = {
  // ---- night tuning report ----
  title: "# 调参（夜里）",
  rerunTitle: "# 调参（夜里）",
  alreadyTuned: "- 今晚已经调过了",
  noChange: "- 今晚没改参数",
  changeLine: (param: unknown, from: unknown, to: unknown, reason: unknown) => `- ${param}：${from} → ${to}（${reason}）`,
  changeFailed: (param: unknown, error: unknown) => `- ${param} 没改成：${error}`,
  heldAtFloor: (param: unknown, floor: unknown, current: unknown) => `- ${param} 不再往下调：已经到调参器的下限 ${floor} 附近（现在 ${current}）`,
  // ---- the day's measurements ----
  dayStatsSpend: (spentUsd: unknown, limitUsd: unknown, wakeCount: unknown, judgeFail: unknown, p90: unknown) => `- 这一天：花了 $${spentUsd}（上限 $${limitUsd}）；叫醒联想 ${wakeCount} 次、判断没回来 ${judgeFail}、p90 ${p90}ms；`,
  dayStatsMounts: (mounted: unknown, opened: unknown, midworkShare: unknown) => `挂了 ${mounted} 页、30 分钟内翻了 ${opened} 页；干活时联想占花费 ${midworkShare}`,
  dayStatsReplay: (previous: unknown, current: unknown, cases: unknown) => `；老题回测 ${previous} → ${current}（${cases} 道）`,
  // ---- reasons for a change ----
  rollbackReason: (param: unknown, from: unknown, to: unknown, metric: unknown, before: unknown, after: unknown) => `退回：上一晚把 ${param} 从 ${from} 改成 ${to}，${metric} 从 ${before} 变成 ${after}，变坏了`,
  spendHighWidenMinutes: (spentUsd: unknown, limitUsd: unknown, midworkShare: unknown) => `一天花了 $${spentUsd}（上限 $${limitUsd}），干活时联想占 ${midworkShare}：隔久一点`,
  spendHighWidenTools: (spentUsd: unknown, limitUsd: unknown, midworkShare: unknown) => `一天花了 $${spentUsd}（上限 $${limitUsd}），干活时联想占 ${midworkShare}：多用几次工具再联想`,
  wakeSlowFewerItems: (judgeFail: unknown, p90: unknown, limitMs: unknown) => `叫醒时的判断 ${judgeFail} 没回来、热的 p90 ${p90}ms（上限 ${limitMs}ms）：每次少问几条条目`,
  itemsCutNotFaster: (night: unknown, p90Before: unknown, failBefore: unknown, p90Now: unknown, failNow: unknown) => `- assoc.itemsK 不再减：${night} 那晚为了快减过，减之前 p90 ${p90Before}ms、${failBefore} 没回来，现在 ${p90Now}ms、${failNow}，没变快`,
  spendLowMoreOften: (spentUsd: unknown, limitUsd: unknown) => `一天只花了 $${spentUsd}（上限 $${limitUsd}），判断也不慢：干活时联想勤一点`,
  spendLowMoreItems: (spentUsd: unknown, max: unknown) => `一天只花了 $${spentUsd}，判断也不慢：条目往回多问几条（最多回到 ${max}）`,
  thresholdLower: (replayPass: unknown, openRate: unknown) => `老题回测只过 ${replayPass}，挂上的{{ta}}翻了 ${openRate}：门槛放低一点，多挂对的页`,
  thresholdRaise: (replayPass: unknown, perAssoc: unknown, openRate: unknown) => `老题回测过 ${replayPass}，一次挂 ${perAssoc} 页、只翻 ${openRate}：门槛抬高一点，挂少挂准`,
};
