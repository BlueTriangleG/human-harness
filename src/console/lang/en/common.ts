import type { Strings } from "../zh.ts";
import type { common as zh } from "../zh/common.ts";

export const common: Strings<typeof zh> = {
  locale: "en-US",
  numbers: "compact",
  dates: "words",
  dateTime: "{date}, {time}",
  comma: ", ",
  listSep: ", ",
  dash: "—",
  expand: "Show more",
  collapse: "Show less",
  close: "Close",
  loading: "Loading…",
  justNow: "just now",
  minutesAgo: "{n} min ago",
  hoursAgo: "{n} {n|hour|hours} ago",
  daysAgo: "{n} {n|day|days} ago",
  now: "now",
  today: "Today",
  rows: "{n} {n|record|records}",
  times: "{n} {n|time|times}",
  turns: "{n} {n|turn|turns}",
  idle: "idle",
  clipped: "… ({n} {n|character|characters} left out) …",
  image: "[image]",
};
