import type { Strings } from "../zh.ts";
import type { settings as zh } from "../zh/settings.ts";

export const settings: Strings<typeof zh> = {
  loading: "Checking…",
  notSet: "No system permission check is set up for this role (instance config console.permissionsCheck), so there is nothing to list.",
  failed: "Could not check: {error}",
  checked: "Checked at {time}. The check runs as {user}; the system counts every command {me} runs against {program}.",
  recheck: "Check again",
  status: { granted: "Granted", missing: "Not granted", unknown: "Can't tell" },
  names: { screen: "Screen & System Audio Recording", ax: "Accessibility", fda: "Full Disk Access", automation: "Automation", files: "Files & Folders" },
  open: "Open System Settings",
  look: "See it in System Settings",
  add: "Program to add: ",
  copy: "Copy path",
  copied: "Copied",
  grants: "Grant permissions",
  how: "On that pane click “+”, choose the file above, then turn on its switch. If the file is in a hidden folder, press ⌘⇧G in the file picker and paste the path.",
};
