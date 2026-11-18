# Changing files and committing
Summary: Do not read a big file whole and write it back; before making a new file see whether one of that name exists; commit only the files you changed; the shell eats `$` and quotes.
When to open: When you are about to change a big file, make a new script or file, commit with git, or write text with `$` or quotes on the command line.

## Practices
- In a big file change only the lines that need it (the edit tool replaces the text as it stands); do not read the whole file out and write it back.
- Before making a new file, see whether one of that name exists; if it does, look at what is in it first and do not overwrite it.
- Before deleting something, see clearly what it is and whose it is; when unsure, move it aside instead of deleting it.
- git: `git status` shows what changed; `git add` only the files you changed; the commit message says what was done.
- Text with `$`, backticks or quotes on the command line goes in single quotes, or into a file that you then use.
