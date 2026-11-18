"""What HH hands a module's script (docs/contracts/modules.md). Read paths, names and settings here, never hard-code them.

    from hh_env import hh
    goals = os.path.join(hh.workspace, hh.config.get("dataFile", "goals.json"))
"""
import json
import os
from types import SimpleNamespace


def read(env=os.environ):
    return SimpleNamespace(
        workspace=env["HH_WORKSPACE"], state_dir=env["HH_STATE_DIR"],
        module_dir=env["HH_MODULE_DIR"], module_state=env["HH_MODULE_STATE"],
        role_id=env["HH_ROLE_ID"], me=env["HH_ME"], owner=env["HH_OWNER"],
        tz=env["HH_TZ"], lang=env["HH_LANG"], hh_bin=env["HH_BIN"],
        config=json.loads(env.get("HH_MODULE_CONFIG") or "{}"),
    )


hh = read() if "HH_WORKSPACE" in os.environ else None


def words(script):
    """say(key, **holes) for the module a script belongs to (pass __file__): its sentences in the role's language
    (<module>/texts.<lang>.json), else in English (<module>/texts.json), with the holes filled; {me} and {owner} are the
    role's and its owner's names. A script keeps no sentence the role reads in its own code."""
    # a script imported by its tests may have the role's names and language without a workspace (hh unset)
    h = hh or SimpleNamespace(lang=os.environ.get("HH_LANG", "en"), me=os.environ.get("HH_ME", ""), owner=os.environ.get("HH_OWNER", ""))
    d = os.path.dirname(os.path.dirname(os.path.abspath(script)))
    f = next(p for p in (os.path.join(d, "texts.%s.json" % h.lang), os.path.join(d, "texts.json")) if os.path.exists(p))
    with open(f, encoding="utf-8") as fh:
        t = json.load(fh)

    def say(key, /, **holes):   # key positional only: a sentence may have a hole named key
        return t[key].format(me=h.me, owner=h.owner, **holes)
    return say


def forms(script):
    """form(key) for the module a script belongs to (pass __file__): what its code writes for code to read back (a tag,
    a heading, a file name, the words a rule matches), in the role's language (<module>/forms.<lang>.json), else in
    English (<module>/forms.json); not formatted, a value may be a list. form.every(key) is every language's, the
    role's own first, lists flattened: a role reads what it may have written in another language."""
    lang = (hh.lang if hh else os.environ.get("HH_LANG", "en"))
    d = os.path.dirname(os.path.dirname(os.path.abspath(script)))
    files = sorted(f for f in os.listdir(d) if f == "forms.json" or (f.startswith("forms.") and f.endswith(".json")))
    every = {}
    for f in files:
        with open(os.path.join(d, f), encoding="utf-8") as fh:
            every[f] = json.load(fh)
    own = every.get("forms.%s.json" % lang) or every["forms.json"]

    def form(key):
        return own[key]

    def all_of(key):
        out = []
        for t in (own, *every.values()):
            for v in (t[key] if isinstance(t[key], list) else [t[key]]):
                if v not in out:
                    out.append(v)
        return tuple(out)
    form.every = all_of
    return form

# Started outside HH (a launchd job, the role's shell through a forwarder) with only env.json: the on modules' commands
# are not on PATH yet, so put their bin/ dirs in front, as HH does for the scripts it starts
_bins = os.environ.get("HH_MODULE_BINS", "")
if _bins and not os.environ.get("PATH", "").startswith(_bins):
    os.environ["PATH"] = _bins + ":" + os.environ.get("PATH", "")
