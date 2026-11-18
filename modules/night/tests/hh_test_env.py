"""The module environment for a made-up role, set before a test imports a script, and the scripts on sys.path.
HH_WORKSPACE is left unset: each test gives the scripts its own workspace (a copied one, or WS set by hand)."""
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
# The night module's people config for the made-up role (see night_names.py)
CONFIG = {
    "ownerAliases": ["lz"], "transcriptPeople": {"xiaohe": "小禾"}, "genders": {"laolin": "m", "小禾": "f", "阿青": "f"},
    "commonWords": ["kestrel"],
    "retiredFiles": ["memory/laolin.md", "memory/us.md", "memory/kept-words.md", "memory/laolin-interests.md", "memory/midterm/people.md",
                     "memory/people/xiaohe.md", "memory/people/xiaohe-us.md", "memory/people/gua.md", "memory/people/ayu.md",
                     "memory/people/shushi.md", "memory/people/riverside-home.md"],
}
_tmp = Path(tempfile.mkdtemp(prefix="hh-night-test-"))
for k, v in {"HH_STATE_DIR": _tmp / "state", "HH_MODULE_DIR": SCRIPTS.parent, "HH_MODULE_STATE": _tmp / "module",
             "HH_ROLE_ID": "test", "HH_ME": "阿青", "HH_OWNER": "laolin", "HH_TZ": "Australia/Melbourne", "HH_LANG": "zh",
             "HH_BIN": _tmp / "no-hh", "HH_MODULE_CONFIG": json.dumps(CONFIG, ensure_ascii=False)}.items():
    os.environ.setdefault(k, str(v))
LIB = SCRIPTS.parents[1] / "_lib"
sys.path[:0] = [str(SCRIPTS), str(LIB)]
os.environ.setdefault("PYTHONPATH", str(LIB))   # the scripts a test starts find hh_env too


def with_words(scripts):
    """Scripts copied out of the module into <dir>/scripts: hh_env beside them (they may run isolated, -I) and the
    module's language files in <dir>, where words(__file__) and forms(__file__) look for them."""
    shutil.copy(LIB / "hh_env.py", Path(scripts) / "hh_env.py")
    for f in SCRIPTS.parent.glob("*.json"):
        shutil.copy(f, Path(scripts).parent / f.name)
