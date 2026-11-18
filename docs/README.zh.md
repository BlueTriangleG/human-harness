# HH 文档

按这个顺序读。English: [README.md](README.md).

1. **上手**：仓库的 [README](../README.zh-CN.md#上手)。跑 `npx human-harness`（或者 clone 后跑 `./setup`），跟角色说话。
2. **新角色一步一步来**：[new-role.zh.md](new-role.zh.md)。`./setup` 替你做了什么，自己动手怎么做（`hh new`、`hh modules install`），怎么检查角色，怎么给它接聊天渠道（WhatsApp、QQ），怎么卸载。
3. **模块**：角色能做什么，每一样怎么开、怎么关。自带的模块列在 [development.md](development.md#built-in-modules)（英文）；模块是什么、怎么声明、怎么自己写一个，看 [contracts/modules.md](contracts/modules.md)（英文）。
4. **配置说明**：[contracts/instance-config.md](contracts/instance-config.md)（英文），角色 `instance.json` 的每一项：新角色必须有的、大多数角色会改的、很少碰的。
5. **常见问题**：[faq.zh.md](faq.zh.md)。要哪种 Claude 账号、钱算谁的，开权限页、配对、换浏览器、卸载、换模型、Linux。

**详细的工作方式**：[how-it-works.zh.md](how-it-works.zh.md)。一个 Human 能做什么、让它扛住长远目标的每日循环、一个例子、完整的实绩、各部分怎么拼在一起。

## 给改 HH 本身的人

- [contracts/](contracts/README.md)：内核、模块和角色数据之间的约定（工作区的布局、夜里整理、感官、渠道、语言包……），一项一页，有目录（英文）。
- [lang-glossary.md](lang-glossary.md)：英文里每样东西只用一个名字，写或改英文的人用。
- [development.md](development.md)（英文）：HH 是怎么搭起来的、命令、代码布局、规矩，和 `npm test`。
