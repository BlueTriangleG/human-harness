"""Who is who in the night's words and rules (docs/contracts/workspace-layout.md): the role and its owner from the module
environment, the owner's key from the registry, and what a few checks need to know about people from the night
module's config. Nothing here names a particular role."""
import json
import os
from pathlib import Path

CONFIG = json.loads(os.environ.get("HH_MODULE_CONFIG") or "{}")
ME = os.environ.get("HH_ME") or "我"
OWNER = os.environ.get("HH_OWNER") or "主人"


def owner_key(ws):
    """The registry entry whose privacy is owner: its key names the owner's files. Without one, the owner's name."""
    try:
        reg = json.loads((Path(ws) / "memory/people/registry.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return OWNER
    return next((k for k, v in reg.items() if isinstance(v, dict) and v.get("privacy") == "owner"), OWNER)


# What a few checks need to know about people, from the night module's config (all empty for a role that sets none):
OWNER_ALIASES = tuple(CONFIG.get("ownerAliases") or ())        # other spellings of the owner in the role's notes
TRANSCRIPT_PEOPLE = dict(CONFIG.get("transcriptPeople") or {})  # key -> name: people besides the owner whose whole conversations HH keeps
GENDERS = dict(CONFIG.get("genders") or {})                     # name -> "m" / "f": which pronoun a person's lines use
COMMON_WORDS = tuple(CONFIG.get("commonWords") or ())          # the role's own words the lint takes as ordinary, not as names
# The role's one-off move of its person files into the event store: the files it took (config retiredFiles), and the
# owner's file in this folder says the move has happened
RETIRED_DIR = "memory/archive/retired-20261103"
RETIRED_FILES = tuple(CONFIG.get("retiredFiles") or ())


def retired_flag(key):
    return f"{RETIRED_DIR}/{key}.md"
