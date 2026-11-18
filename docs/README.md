# HH documentation

Read in this order. 中文：[README.zh.md](README.zh.md).

1. **Get started**: the repository's [README](../README.md#get-started). Run
   `npx human-harness` (or clone and run `./setup`), talk to the role.
2. **A new role, step by step**: [new-role.md](new-role.md). What `./setup` does and how to do it by hand
   (`hh new`, `hh modules install`), checking a role, giving it a chat channel (WhatsApp, QQ), removing it.
3. **Modules**: what a role can do, and turning each part on or off. The built-in ones are listed in the
   [development.md](development.md#built-in-modules); [contracts/modules.md](contracts/modules.md) says what a module is, how one is
   declared and how to write your own.
4. **Configuration**: [contracts/instance-config.md](contracts/instance-config.md), every key of a role's
   `instance.json`: what a new role must have, what most roles change, what is rarely touched.
5. **Questions**: [faq.md](faq.md). Which Claude account and who pays, the permission page, pairing, using another
   browser, removing a role, using another model, Linux.

**How it works, in full**: [how-it-works.md](how-it-works.md). What a Human does, the daily loop that carries a long
goal, an example, the full track record, and the parts.

## For people working on HH itself

- [contracts/](contracts/README.md): the agreements between the kernel, the modules and a role's data (the workspace's
  layout, the night, the senses, channels, language packs, …), one page each, with an index.
- [lang-glossary.md](lang-glossary.md): one English name for each thing, for anyone writing or changing English text.
- [development.md](development.md): how HH is put together, its commands, the layout of the code, its rules, and
  `npm test`.
