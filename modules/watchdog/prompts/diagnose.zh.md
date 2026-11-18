「{me}」（跑在 Human Harness 上的一个角色）有一个通道断了，看门狗的固定恢复动作救不回来。
症状：[{kind}] {what}

请找出问题在哪。可以看：看门狗的事故记录 {incidents}；角色的状态目录 {state_dir}（logs/hh.jsonl 一行一条 JSON，用 tail、grep、jq 看；channels/ 里是每个桥的日志）；用 `launchctl list`、`launchctl print` 看它的任务。
{background}

规则（必须遵守）：
- 只读诊断，不修。不改任何文件、配置、会话，不重启任何东西，不发消息。修不修由{owner}决定。
- 不要把日志里的私人聊天内容原样写进报告。
- 你的全部输出就是给{owner}的报告：口语、不超过 900 字——出了什么事／问题在哪（哪个日志、哪一行附近）／我建议怎么修／需要你决定什么。
