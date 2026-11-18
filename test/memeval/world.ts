// A made-up month in the life of a demo role (阿青), for the offline memory evaluation (test/memeval/run.ts).
// Nobody here is real: the owner is ada, the friends are 小贝, 阿岩 and 苏苏. Days count back from NOW.
// Each event has a key the questions refer to; the store gives it its own id (e0001 …).
import type { EventStore } from "../../src/memory/events/store.ts";

export const DAY = 86_400_000;
/** 2026-11-17 02:00 UTC: "now" for the whole world (a Tuesday) */
export const NOW = Date.UTC(2026, 10, 17, 2, 0);

interface Ev { key: string; title: string; importance: number; people: string[]; entries: Array<[number, string]>; status?: "ongoing" | "done" }

export const WORLD: Ev[] = [
  { key: "pottery", title: "学做陶艺", importance: 3, people: [], entries: [
    [20, "第一次去陶艺课，拉坯拉塌了三次"], [13, "第二次陶艺课做出一个歪碗"], [6, "歪碗烧出来了，釉色发蓝"]] },
  { key: "piano", title: "小贝考钢琴八级", importance: 3, people: ["小贝"], entries: [
    [18, "小贝说下个月考钢琴八级，曲目是一首夜曲"], [4, "小贝钢琴八级考过了，请大家吃火锅"]] },
  { key: "job", title: "ada 换工作", importance: 4, people: ["ada"], entries: [
    [25, "ada 说在考虑去一家做地图的公司"], [10, "ada 正式入职地图公司，通勤变成四十分钟"]] },
  { key: "home", title: "ada 住在哪", importance: 3, people: ["ada"], entries: [
    [28, "ada 搬到东区的公寓，楼下有面包店"], [5, "ada 退了东区的房子，搬回西区的老小区"]] },
  { key: "stars", title: "拍星轨", importance: 3, people: ["阿岩"], entries: [
    [22, "和阿岩去山上拍星轨，冻得手发麻"], [15, "星轨照片被选进摄影群的周赛"]] },
  { key: "pork", title: "第一次做红烧肉", importance: 2, people: [], entries: [
    [3, "第一次做红烧肉，糖放多了发苦"]] },
  { key: "birthday", title: "苏苏生日", importance: 2, people: ["苏苏"], entries: [
    [9, "苏苏生日，送了她一盆多肉"]] },
  { key: "film", title: "看登月的老电影", importance: 2, people: ["ada"], entries: [
    [12, "和 ada 看了一部讲登月的老电影，看完聊到半夜"]] },
  { key: "bike", title: "自行车掉链子", importance: 2, people: ["阿岩"], entries: [
    [16, "自行车链条掉了，阿岩教我自己上链条"]] },
  { key: "japanese", title: "学日语", importance: 3, people: [], entries: [
    [27, "开始用卡片背日语五十音"], [8, "五十音背完了，开始学动词变形"]] },
  { key: "trip", title: "年底去海边小镇", importance: 3, people: ["小贝"], status: "ongoing", entries: [
    [2, "和小贝商量年底去海边小镇，订了一间民宿"]] },
  { key: "mint", title: "阳台的薄荷", importance: 1, people: [], entries: [
    [19, "阳台的薄荷长疯了，分给邻居一盆"]] },
  { key: "cold", title: "感冒发烧", importance: 2, people: [], entries: [
    [14, "感冒发烧，在家躺了两天"]] },
  { key: "run", title: "跑步", importance: 3, people: [], entries: [
    [11, "第一次跑完五公里"], [1, "五公里跑进了三十分钟"]] },
  { key: "bookclub", title: "读书会", importance: 2, people: ["苏苏"], entries: [
    [24, "读书会在图书馆二楼，苏苏带了一本推理小说"], [7, "读书会挪到河边的咖啡馆，图书馆二楼在装修"]] },
  { key: "cat", title: "阿岩的猫", importance: 2, people: ["阿岩"], entries: [
    [26, "阿岩领养了一只橘猫，叫豆包"], [3, "阿岩说豆包这个名字太像狗，猫改名叫团子"]] },
  { key: "swim", title: "每周游泳", importance: 2, people: [], entries: [
    [23, "每周二晚上去游泳"], [9, "游泳挪到每周四晚上，周二要加班"]] },
  { key: "band", title: "小贝喜欢的乐队", importance: 1, people: ["小贝"], entries: [
    [21, "小贝最喜欢一支叫晴天车站的乐队"], [6, "小贝说现在最喜欢的乐队换成了海盐汽水"]] },
  { key: "commute", title: "ada 怎么上班", importance: 1, people: ["ada"], entries: [
    [17, "ada 每天骑自行车去上班"], [2, "ada 买了一辆电动车，不再骑自行车上班"]] },
];

/** Fill the store with the world; returns event key → id. */
export function buildWorld(s: EventStore): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const e of WORLD) {
    const row = s.createEvent({
      title: e.title, summary: e.entries.map(([, t]) => t).join("；"), gist: e.entries.at(-1)![1].slice(0, 40),
      why: e.importance >= 4 ? "身边人的大变化" : "", importance: e.importance, status: e.status ?? "done",
      entities: e.people.map((name) => ({ name, kind: "person", role: "with" })),
    }, "memeval");
    ids[e.key] = row.id;
    e.entries.forEach(([d, text], i) => s.addEntry({
      event: row.id, at: NOW - d * DAY, kind: "happened", full: text, gist: text.slice(0, 30), title: text.slice(0, 8),
      people: e.people, source: [`c:memeval-${e.key}-${i}`],
    }, "memeval"));
  }
  return ids;
}
