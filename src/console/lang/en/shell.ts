import type { Strings } from "../zh.ts";
import type { shell as zh } from "../zh/shell.ts";

export const shell: Strings<typeof zh> = {
  title: "{me}'s console",
  heading: "{me}",
  viewsLabel: "Views of this page",
  navLabel: "Views",
  nav: { now: "Talk", activity: "Activity", memory: "Memory", notes: "Notes", run: "Running", machine: "This computer", settings: "Settings" },
  views: { timeline: "Timeline", gate: "Gate", events: "What {me} remembers", prefix: "Carried every turn", input: "Model input", permissions: "System permissions", roles: "Roles", monitor: "Monitor" },
  lang: { label: "Interface language", zh: "中文", en: "English" },
  notes: { label: "Notifications", markRead: "Mark all read", unread: "{n} unread", times: "{n} times", bellLabel: "Notifications ({n} unread)" },
  skip: { content: "Skip to the page", input: "Skip to the message box" },
  demo: "Demo data",
  demoTitle: "Made-up demo data, not real records",
  state: {
    connecting: "Connecting to hhd…",
    consoleDown: "Can't reach the console",
    hhdSilent: "hhd is not responding",
    asleep: "Asleep",
    sleepy: "Getting sleepy",
    nightRest: "Night rest",
    focus: "Focusing",
    awake: "Awake",
    until: ", until {time}",
    turning: ", compacting memory (page turn)",
    todos: ", {n} {n|thing|things} to do after waking",
  },
};
