# 第三方代码

- `server/vendor/bilibili_mcp/mcp_server.py`：来自 c1overzz/dsh-bili-scroll（commit 5be5f6d，2026-10-24）里 vendor 的
  bilibili-mcp。原作 [AGI_Ananas/bilibili-mcp](https://github.com/adoresever/bilibili-mcp)，MIT，
  Copyright (c) 2026 AGI_Ananas —— 见 `server/vendor/bilibili_mcp/LICENSE`。原样保留，没改。
- 插件的功能设计、提示规矩（`skills/bilibili/SKILL.md` 里的「规矩」「评论怎么写」）、评论复核、私信接口、
  画面帧裁切的做法参考了 [c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)，MIT，
  Copyright (c) 2026 c1overzz —— 见 `server/vendor/LICENSE.dsh-bili-scroll`。
- 首页推荐、UP 追更、多路召回、三连节流、稍后再看的做法参考了它的分支：holoiallo、minedalang（dsh-bili-scroll-plus）、
  FunnyMudXD、littlefallenstar（都是 MIT，基于上面那个仓库）。
- 底层库：[bilibili-api-python](https://github.com/Nemo2011/bilibili-api)（GPL-3.0-or-later，作为依赖安装，不随插件分发）。
