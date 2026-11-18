# ops

What runs around the code rather than in it:

- `check-instance-entries.sh` — run by hh-guard before a deploy: the instance file's entries against the tree to deploy.
- `launchd/*.plist.template` — the hhd and console job files `hh modules install` fills in on macOS (src/services/launchd.ts).

What was changed on a particular role's machine (its root scripts, its launchd jobs, its backup) belongs to that role,
not to this repository: it is kept beside the role's data.
