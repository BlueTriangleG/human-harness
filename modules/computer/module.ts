// Computer: HH's computer tool (screenshots, clicks, typing on the Mac's desktop). It goes through OpenClaw.app, which
// holds the macOS permissions for it. HH's own code (src/tools/computer.ts); this declaration lists it and checks the app.
import { existsSync } from "node:fs";
import { defineModule } from "../../src/modules/api.ts";

const APP = "/Applications/OpenClaw.app";

export default defineModule({
  name: "computer",
  summary: "the computer tool: the Mac's screen, mouse and keyboard, through OpenClaw.app (HH's own, src/tools/computer.ts)",
  required: true,
  requires: { setup: ["OpenClaw.app installed, with Screen Recording and Accessibility allowed"] },
  check: async () => [existsSync(APP) ? { status: "ok", text: `${APP} is there` } : { status: "setup", text: `install ${APP} and allow it Screen Recording and Accessibility` }],
});
