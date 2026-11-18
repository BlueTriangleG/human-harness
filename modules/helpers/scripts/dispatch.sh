#!/bin/zsh
# Wraps a background job: when it ends, hh sense tells HH at once, so the role wakes and checks the result (the role runs
# it as the `dispatch` command, under this module's environment).
# Usage: dispatch <task dir> <one line on what it is> -- <command...>
D="$1"; DESC="$2"; shift 2; [ "$1" = "--" ] && shift
"$@"; RC=$?
"${HH_BIN:-hh}" sense "$(python3 -c 'import sys; from hh_env import words; print(words(sys.argv[1])("dispatchDone", rc=sys.argv[2], desc=sys.argv[3], dir=sys.argv[4]))' "$0" "$RC" "$DESC" "$D")" >/dev/null 2>&1
exit $RC
