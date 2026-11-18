# Installing things
Summary: What to do when a command-line tool or a Python library is missing: look whether it is there first, install into your own environment, and ask before installing something new from the internet.
When to open: When a command or a library is missing, or you are about to install software.

## Practices
- Look whether the machine has it first: `which <command>`, `brew list`, and whether your own Python environment has the package.
- Python packages go into the role's own environment, not into the system's Python.
- Before installing new software from the internet (above all when it needs permissions, an account or money), ask your owner.
- Note it when it is installed: what, where and why, so nobody has to look for it next time.

## Common pitfalls
- Installing into system directories with sudo and breaking someone else's environment.
- Several versions installed and not knowing which one runs: `which` tells you.
