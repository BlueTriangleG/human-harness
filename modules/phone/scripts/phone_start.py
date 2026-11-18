"""Starts the Android emulator and waits until it has booted (texts: usage, said for --help)."""
import os
import shutil
import subprocess
import sys
import time

from hh_env import hh, words

say = words(__file__)

SDK = os.environ.get("ANDROID_HOME") or os.path.expanduser("~/Library/Android/sdk")
ADB = os.path.join(SDK, "platform-tools", "adb")
EMU = os.path.join(SDK, "emulator", "emulator")
PORT = int(hh.config.get("port", 5554))
SERIAL = f"emulator-{PORT}"


def booted():
    r = subprocess.run([ADB, "-s", SERIAL, "shell", "getprop", "sys.boot_completed"], capture_output=True, text=True)
    return r.stdout.strip() == "1"


def main():
    if sys.argv[1:]:   # it takes no argument: `--help` must not boot a 3 GB emulator
        print(say("usage"))
        return
    if not hh.config.get("avd"):
        sys.exit(say("noAvd"))
    if booted():
        print(say("alreadyOn", serial=SERIAL))
        return
    if shutil.which("load") and subprocess.run(["load", "room", "phone"]).returncode != 0:
        sys.exit(1)
    log_path = os.path.join(hh.module_state, "emulator.log")
    log = open(log_path, "a")
    cmd = [EMU, "-avd", hh.config["avd"], "-port", str(PORT), "-no-boot-anim", "-memory", str(hh.config.get("memoryMb", 3072))]
    proc = subprocess.Popen(cmd + ([] if hh.config.get("window", True) else ["-no-window"]), stdout=log, stderr=log, start_new_session=True)
    for _ in range(120):
        time.sleep(3)
        if booted():
            print(say("booted", serial=SERIAL))
            return
        if proc.poll() is not None:
            sys.exit(say("exited", log=log_path))
    sys.exit(say("timedOut", log=log_path))


if __name__ == "__main__":
    main()
