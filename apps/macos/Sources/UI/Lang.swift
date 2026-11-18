import Foundation

/**
 * The native layer's words: windows, menus, the permission page, the menu bar, notifications. English is the base and
 * Chinese a pack of the same keys, as in the console (src/console/lang): plain data, {name} where something fills in.
 * A role's app speaks its role's language (role.json beside the app); Human.app, the system's. A key missing from a pack
 * falls back to English. test/native-lang.test.ts keeps the two packs' keys and fill-ins alike.
 */
enum Lang {
  static let en: [String: String] = [
    "state.down": "not answering",
    "state.trouble": "trouble today",
    "state.asleep": "asleep",
    "state.busy": "at work",
    "state.idle": "idle",
    "load.ok": "fine",
    "load.tight": "tight",
    "load.danger": "danger",
    "quota": "quota",
    "load": "load",
    "openWindow": "Open Human",
    "openMonitor": "Open the monitor",
    "newHuman": "New Human…",
    "atLogin": "Open at login",
    "quit": "Quit",
    "noConsole": "No Humans on this Mac yet. Open Human to make one.",
    "noRolesTitle": "No Humans on this Mac yet",
    "noRolesBody": "A Human is someone who lives on this Mac, with a name, a character, a memory and permissions of their own. Every Human you make is listed here, with what they are doing and how they are.",
    "makeOne": "Make one",
    "create": "Create your Human",
    "wizardFailed": "The wizard did not start: {why}",
    "makeStep": "Or open Terminal, go to the folder you downloaded HH into, and run:",
    "copy": "Copy",
    "copied": "Copied",
    "makeAfter": "It opens the same wizard. Made one already? It may still be starting: this page refreshes by itself.",
    "trouble": "{name}: stopped {stops}, refused {refusals} today",
    "down": "{name}'s console stopped answering",
    "menu.quitApp": "Quit {name}",
    "menu.edit": "Edit",
    "menu.undo": "Undo",
    "menu.cut": "Cut",
    "menu.copy": "Copy",
    "menu.paste": "Paste",
    "menu.selectAll": "Select All",
    "grants.title": "Permissions for {name}",
    "grants.intro": "Everything {name} does counts against this app. Turn these on once: a new version or a new name keeps them.",
    "grants.fda": "Full Disk Access",
    "grants.fdaWhy": "read protected files such as Mail and Photos",
    "grants.fdaHow": "Open Settings, then drag the icon on the left into the list",
    "grants.screen": "Screen & System Audio Recording",
    "grants.screenWhy": "take screenshots, see what is on the screen",
    "grants.ax": "Accessibility",
    "grants.axWhy": "click and type for you",
    "grants.ask": "Turn on",
    "grants.open": "Open Settings",
    "grants.flip": "Turn on {name} in Settings",
    "grants.done": "All on.",
    "grants.later": "Not now",
  ]

  static let zh: [String: String] = [
    "state.down": "不答应",
    "state.trouble": "今天出过事",
    "state.asleep": "睡着",
    "state.busy": "在忙",
    "state.idle": "空着",
    "load.ok": "正常",
    "load.tight": "偏紧",
    "load.danger": "危险",
    "quota": "额度",
    "load": "负载",
    "openWindow": "打开 Human",
    "openMonitor": "打开监视台",
    "newHuman": "新建一个 Human…",
    "atLogin": "开机时打开",
    "quit": "退出",
    "noConsole": "这台 Mac 上还没有 Human。打开 Human 建一个。",
    "noRolesTitle": "这台 Mac 上还没有 Human",
    "noRolesBody": "Human 是住在这台 Mac 上的一个人：有自己的名字、性格、记忆和权限。建好的每个 Human 都会列在这里，看得到它在做什么、状态好不好。",
    "makeOne": "建一个",
    "create": "创建你的 Human",
    "wizardFailed": "向导没起来：{why}",
    "makeStep": "或者打开终端，进到下载 HH 的那个文件夹，运行：",
    "copy": "拷贝",
    "copied": "已拷贝",
    "makeAfter": "打开的是同一个向导。已经建过的话，它可能还在启动：这一页会自己刷新。",
    "trouble": "{name}：今天被停 {stops} 次、被拒 {refusals} 次",
    "down": "{name} 的控制台不答应了",
    "menu.quitApp": "退出 {name}",
    "menu.edit": "编辑",
    "menu.undo": "撤销",
    "menu.cut": "剪切",
    "menu.copy": "拷贝",
    "menu.paste": "粘贴",
    "menu.selectAll": "全选",
    "grants.title": "给{name}开权限",
    "grants.intro": "{name}做的事都算在这个 app 头上。开一次就够了：换版本、改名都不用再开。",
    "grants.fda": "完全磁盘访问",
    "grants.fdaWhy": "读邮件、照片这些受保护的文件",
    "grants.fdaHow": "点「打开设置」，再把左边这个图标拖进列表",
    "grants.screen": "录屏与系统录音",
    "grants.screenWhy": "截屏、看屏幕上有什么",
    "grants.ax": "辅助功能",
    "grants.axWhy": "替你点按钮、打字",
    "grants.ask": "开启",
    "grants.open": "打开设置",
    "grants.flip": "在设置里把{name}的开关打开",
    "grants.done": "都开好了。",
    "grants.later": "以后再说",
  ]

  private struct Role: Decodable { let lang: String? }
  /** "zh" or "en": the role's language beside a role's app, else the system's first */
  static let code: String = {
    let role = (try? Data(contentsOf: Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("role.json")))
      .flatMap { try? JSONDecoder().decode(Role.self, from: $0).lang }
    return (role ?? Locale.preferredLanguages.first ?? "en").hasPrefix("zh") ? "zh" : "en"
  }()

  static func t(_ key: String, _ fill: [String: String] = [:]) -> String {
    var s = (code == "zh" ? zh[key] : nil) ?? en[key] ?? key
    for (k, v) in fill { s = s.replacingOccurrences(of: "{\(k)}", with: v) }
    return s
  }
}
