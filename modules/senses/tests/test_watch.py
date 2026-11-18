import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
WATCH = HERE.parent / "scripts" / "senses_watch.py"


class StopsItsStreams(unittest.TestCase):
    def test_term_takes_the_streams_with_it(self):
        """HH stops the watcher with TERM to its own pid: the processes it streams from (adb logcat …) must not be left behind"""
        tmp = Path(tempfile.mkdtemp(prefix="senses-watch-"))
        state = tmp / "module"
        state.mkdir()
        mark = f"senses-watch-test-{os.getpid()}"
        (state / "senses.json").write_text(json.dumps({"watchers": [{"id": "w", "type": "command", "cmd": [sys.executable, "-c", "import time; time.sleep(60)", mark], "match": "x", "source": "s"}]}))
        env = {**os.environ, "PYTHONPATH": str(HERE.parents[1] / "_lib"), "HH_WORKSPACE": str(tmp), "HH_STATE_DIR": str(tmp),
               "HH_MODULE_DIR": str(HERE.parent), "HH_MODULE_STATE": str(state), "HH_ROLE_ID": "t", "HH_ME": "阿青", "HH_OWNER": "老林",
               "HH_TZ": "UTC", "HH_LANG": "zh", "HH_BIN": str(tmp / "no-hh"), "HH_MODULE_CONFIG": "{}"}
        w = subprocess.Popen([sys.executable, str(WATCH)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        alive = lambda: subprocess.run(["pgrep", "-f", mark], capture_output=True).returncode == 0
        try:
            for _ in range(50):
                if alive(): break
                time.sleep(0.1)
            self.assertTrue(alive(), "the stream started")
            w.send_signal(signal.SIGTERM)
            w.wait(timeout=10)
            for _ in range(30):
                if not alive(): break
                time.sleep(0.1)
            self.assertFalse(alive(), "the stream went with the watcher")
        finally:
            subprocess.run(["pkill", "-f", mark])
            if w.poll() is None: w.kill()


if __name__ == "__main__":
    unittest.main()
