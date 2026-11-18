# console-ui: the console's talk pane

The talk pane (say something to the role as its owner, see its turn: thinking, tool calls and results, the reply) is a
small React app on [assistant-ui](https://www.assistant-ui.com/)'s `useExternalStoreRuntime`. Everything else in the
console stays plain scripts in `src/console/web/js/`.

- `src/main.tsx` mounts into `#chat` of the console page. It shows the Talk tab only on a console whose instance config
  names `console.ownerTokenFile` (the write ports are on); elsewhere it does nothing.
- `src/thread.ts` turns central memory rows into the thread (no React; `test/console-chat.test.ts` runs it).
- Texts are the console language packs (`src/console/lang/<lang>/chat.ts`), read from the page's `#hh-data`.

## Build

The output is committed: `src/console/web/app/chat.js` and `chat.css` (fixed names, listed in `src/console/web.ts`,
first line marked generated). Deploys need no npm and the page loads nothing from outside the console.

Build as the role's user in the hh-fw mirror, then copy the output back into the worktree:

    hh-fw sh 'console-ui/build.sh'
    cp /Volumes/HH/hh-fw/<mirror>/src/console/web/app/chat.{js,css} src/console/web/app/
    cp /Volumes/HH/hh-fw/<mirror>/console-ui/app.sha256 console-ui/

`build.sh` runs `npm ci --ignore-scripts` (exactly `package-lock.json`, no install scripts), `tsc`, `vite build`, and
records the output's sha256 in `app.sha256`. `test/console-chat.test.ts` fails when the committed output differs from
that record (an edit by hand).

## Check that it is reproducible

    hh-fw sh 'console-ui/check.sh'

Installs from the lock file, rebuilds into a temp dir and compares byte for byte with the committed output.

## Dependencies

Versions are exact (`.npmrc` save-exact) and the whole tree was resolved with `npm install --before=2026-11-03`, so every
package was published at least two weeks before it was taken. To update: change `package.json`, run
`npm install --before=<two weeks ago> --ignore-scripts`, rebuild, and send the new list (version, publish date, license,
integrity) for approval with the change.
