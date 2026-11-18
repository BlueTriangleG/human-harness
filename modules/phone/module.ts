// Phone: an Android emulator the role can use. Only what any role needs: a start command (bin/phone-start), the manuals
// for driving the phone with adb, and a setup tutorial. A role's own phone tooling stays in its workspace.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineModule, z } from "../../src/modules/api.ts";

const SDK = process.env.ANDROID_HOME || join(homedir(), "Library", "Android", "sdk");

export default defineModule({
  name: "phone",
  summary: "An Android emulator the role can use: a start command, manuals for driving it, a setup tutorial",
  config: {
    // avd: the emulator's name (emulator -list-avds); port: its console port, the device is emulator-<port>
    shape: { avd: z.string(), port: z.number().int(), memoryMb: z.number().int(), window: z.boolean() },
    defaults: { avd: "", port: 5554, memoryMb: 3072, window: true },
  },
  requires: { setup: ["the Android SDK with its emulator and an AVD (manual 手机/phone, the setup page)", "logging in to apps on the phone, by a person"] },
  check: async (m) => {
    const avd = String(m.config.avd ?? "");
    return [
      existsSync(join(SDK, "platform-tools", "adb")) && existsSync(join(SDK, "emulator", "emulator"))
        ? { status: "ok", text: `adb and the emulator found under ${SDK}` }
        : { status: "setup", text: `no adb or emulator under ${SDK} (set ANDROID_HOME, or install the SDK)` },
      !avd
        ? { status: "setup", text: "no emulator named yet: modules.phone.avd" }
        : existsSync(join(homedir(), ".android", "avd", `${avd}.ini`))
          ? { status: "ok", text: `emulator image ${avd} found` }
          : { status: "setup", text: `no emulator image named ${avd} (~/.android/avd/${avd}.ini)` },
    ];
  },
});
