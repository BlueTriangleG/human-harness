// HH.app's two faces (the entry, main.swift, and the bundles are the framework's: it calls one of these, no @main here).
//   RoleWindowApp: a role's own app (<name>.app, ai.hh.role.<id>): a window on that role's console, paired first.
//   HumanApp: Human.app, no role's: a window on this computer's page (/?human#machine: the roles, each one's console, the
//   monitor), and the menu bar: a dot per role, a line each, a notification when one has trouble.
// Every page is the web console's; this layer only opens windows, pairs, and does what a page cannot.
import AppKit
import ServiceManagement
import SwiftUI
import UserNotifications
import WebKit

/** the console page in a window; the app's web views share one store, so pairing once covers them all */
struct ConsoleView: NSViewRepresentable {
  let url: URL?
  func makeNSView(context: Context) -> WKWebView { let w = WKWebView(frame: .zero); w.navigationDelegate = context.coordinator; return w }
  func updateNSView(_ web: WKWebView, context: Context) {
    if let url, web.url?.absoluteString != url.absoluteString, context.coordinator.loaded != url { context.coordinator.loaded = url; web.load(URLRequest(url: url)) }
  }
  func makeCoordinator() -> Coordinator { Coordinator() }
  final class Coordinator: NSObject, WKNavigationDelegate {
    var loaded: URL?
    /**
     * A role's app's link to its page of permissions (the settings page has one, ai.hh.role.<id>://grants): this app's
     * own opens that page here, another role's goes to that app. No other link leaves the page: a role's page could
     * otherwise have the app open anything a URL scheme reaches.
     */
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
      guard let url = a.request.url, let scheme = url.scheme, isGrants(url) else { decisionHandler(.allow); return }
      decisionHandler(.cancel)
      if scheme == Bundle.main.bundleIdentifier { Grants.openPage() } else { NSWorkspace.shared.open(url) }
    }
  }
}

/** ai.hh.role.<id>://grants, the id as role ids go */
func isGrants(_ url: URL) -> Bool {
  guard let scheme = url.scheme, scheme.hasPrefix("ai.hh.role."), url.host == "grants" else { return false }
  return Consoles.validID(String(scheme.dropFirst("ai.hh.role.".count)))
}

/** the few words of the native layer (Lang.swift: English, and a Chinese pack) */
enum Words {
  static func state(_ k: RoleState.Kind) -> String { Lang.t("state.\(k)") }
  static func load(_ level: String) -> String { Lang.t("load.\(level)") }
  static var quota: String { Lang.t("quota") }
  static var loadWord: String { Lang.t("load") }
  static var openWindow: String { Lang.t("openWindow") }
  static var openMonitor: String { Lang.t("openMonitor") }
  static var newHuman: String { Lang.t("newHuman") }
  static var atLogin: String { Lang.t("atLogin") }
  static var quit: String { Lang.t("quit") }
  static var noConsole: String { Lang.t("noConsole") }
  static var noRolesTitle: String { Lang.t("noRolesTitle") }
  static var noRolesBody: String { Lang.t("noRolesBody") }
  static var makeOne: String { Lang.t("makeOne") }
  static var create: String { Lang.t("create") }
  static func wizardFailed(_ why: String) -> String { Lang.t("wizardFailed", ["why": why]) }
  static var makeStep: String { Lang.t("makeStep") }
  static var copy: String { Lang.t("copy") }
  static var copied: String { Lang.t("copied") }
  static var makeAfter: String { Lang.t("makeAfter") }
  static func trouble(_ name: String, _ t: RoleState.Today) -> String { Lang.t("trouble", ["name": name, "stops": "\(t.stops)", "refusals": "\(t.refusals)"]) }
  static func down(_ name: String) -> String { Lang.t("down", ["name": name]) }
}

extension RoleState.Kind {
  var color: NSColor {
    switch self {
    case .down, .trouble: return .systemRed
    case .asleep: return .systemGray
    case .busy: return .systemBlue
    case .idle: return .systemGreen
    }
  }
}

/** this computer's roles, from their consoles' summaries every 30 seconds; pairs the app with each; notifies new trouble */
@MainActor
final class MachineModel: ObservableObject {
  @Published var roles: [RoleState] = []
  @Published var port: Int?
  /** the first look at this computer's consoles is done: before it, nothing is said about there being none */
  @Published var checked = false
  /** the wizard that makes a new Human, while it runs: its page is what Human's window shows */
  @Published var wizard: URL?
  @Published var wizardError: String?
  private var wizardRun: Process?
  private let pairing = Pairing()
  private var paired = Set<Int>()
  private var seen: [Int: (Int, Bool)] = [:]
  private var started = false

  func start() {
    guard !started else { return }
    started = true
    Task { while true { await refresh(); try? await Task.sleep(for: .seconds(30)) } }
  }

  func refresh() async {
    if port == nil { port = await Consoles.anyPort() }
    // no console answers (the last role uninstalled, or all stopped): no rows left from before
    let now = await Consoles.states()
    guard port != nil, now.contains(where: \.up) else { self.port = nil; roles = []; checked = true; return }
    for r in now where r.up && !paired.contains(r.port) {
      if await pairing.ensure(r.info) { paired.insert(r.port) }
    }
    for r in now { note(r) }
    roles = now
    checked = true
  }

  /** a notification when a role's trouble today grows, or its console stops answering */
  private func note(_ r: RoleState) {
    let n = r.today.stops + r.today.refusals
    defer { seen[r.port] = (n, r.up) }
    guard let (before, wasUp) = seen[r.port] else { return }
    let body = !r.up && wasUp ? Words.down(r.name) : n > before ? Words.trouble(r.name, r.today) : nil
    guard let body else { return }
    let c = UNMutableNotificationContent()
    c.title = "Human"
    c.body = body
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "\(r.id)-\(Date().timeIntervalSince1970)", content: c, trigger: nil))
  }

  /**
   * hh setup --wizard --no-open, from the checkout Human was built from (Info.plist: HHCommand, the checkout's bin/hh, and
   * HHNode, the node it runs on: an app opened from the Finder has no node on its PATH). Its first line is the address.
   */
  func startWizard() {
    guard wizardRun == nil else { return }
    let info = Bundle.main.infoDictionary ?? [:]
    guard let hh = info["HHCommand"] as? String, FileManager.default.isExecutableFile(atPath: hh) else {
      wizardError = Words.wizardFailed("HHCommand"); return
    }
    let p = Process(), out = Pipe(), err = Pipe()
    p.executableURL = URL(fileURLWithPath: hh)
    p.arguments = ["setup", "--wizard", "--no-open"]
    var env = ProcessInfo.processInfo.environment
    env.removeValue(forKey: "CLAUDECODE")
    if let node = info["HHNode"] as? String { env["HH_NODE"] = node }
    p.environment = env
    p.standardOutput = out
    p.standardError = err
    // its first line on a thread of its own; the rest read and dropped, so a full pipe never holds the wizard up
    let reading = out.fileHandleForReading
    Thread.detachNewThread {
      var buffer = Data(), sent = false
      while true {
        let chunk = reading.availableData
        if chunk.isEmpty { break }
        if sent { continue }
        buffer.append(chunk)
        guard let nl = buffer.firstIndex(of: 10) else { continue }
        sent = true
        let first = Data(buffer[..<nl])
        let url = (try? JSONSerialization.jsonObject(with: first) as? [String: Any])?["url"] as? String
        Task { @MainActor in self.wizard = url.flatMap(URL.init(string:)); if self.wizard == nil { self.wizardError = Words.wizardFailed(String(decoding: first, as: UTF8.self)) } }
      }
    }
    // its errors read as they come too (a full pipe would hold it up), the last few kB kept for when it fails
    let tail = Tail()
    let errors = err.fileHandleForReading
    Thread.detachNewThread { while true { let c = errors.availableData; if c.isEmpty { break }; tail.add(c) } }
    p.terminationHandler = { done in
      let why = tail.text
      if done.terminationStatus != 0 { NSLog("hh setup --wizard: %@", why) }
      Task { @MainActor in
        if done.terminationStatus != 0, self.wizard == nil { self.wizardError = Words.wizardFailed(why.split(separator: "\n").last.map(String.init) ?? "") }
        self.wizardRun = nil; self.wizard = nil; self.port = nil; await self.refresh()
      }
    }
    do { try p.run(); wizardRun = p; wizardError = nil } catch { wizardError = Words.wizardFailed(error.localizedDescription) }
  }

  func url(monitor: Bool) -> URL? { port.flatMap { URL(string: "http://127.0.0.1:\($0)/?human#machine" + (monitor ? ":monitor" : "")) } }
}

/** the last few kB of a stream, from the thread that reads it to whoever asks */
final class Tail: @unchecked Sendable {
  private var data = Data()
  private let lock = NSLock()
  func add(_ d: Data) { lock.lock(); data.append(d); if data.count > 8192 { data.removeFirst(data.count - 8192) }; lock.unlock() }
  var text: String { lock.lock(); defer { lock.unlock() }; return String(decoding: data, as: UTF8.self) }
}

/** the dots in the menu bar: one per role, in its colour */
func dotsImage(_ roles: [RoleState]) -> NSImage {
  let kinds = roles.isEmpty ? [RoleState.Kind.asleep] : roles.map(\.kind)
  let size = NSSize(width: CGFloat(kinds.count) * 11 + 3, height: 16)
  let img = NSImage(size: size, flipped: false) { _ in
    for (i, k) in kinds.enumerated() { k.color.setFill(); NSBezierPath(ovalIn: NSRect(x: 3 + CGFloat(i) * 11, y: 4, width: 8, height: 8)).fill() }
    return true
  }
  img.isTemplate = false
  return img
}

/** what the menu shows: a line per role (state, quota, load), what it has on hand; the windows; at login */
struct MenuContent: View {
  @ObservedObject var model: MachineModel
  var open: (Bool) -> Void
  @State private var atLogin = SMAppService.mainApp.status == .enabled
  var body: some View {
    if model.roles.isEmpty { Text(Words.noConsole) }
    ForEach(model.roles, id: \.port) { r in   // one console per port; two roles may share an id
      Text("● \(r.name) · \(Words.state(r.kind))" + (r.quota.map { " · \(Words.quota) \($0)%" } ?? "") + (r.load.map { " · \(Words.loadWord) \(Words.load($0))" } ?? ""))
        .foregroundStyle(Color(nsColor: r.kind.color))
    }
    Divider()
    Button(Words.openWindow) { open(false) }
    Button(Words.openMonitor) { open(true) }
    Button(Words.newHuman) { model.startWizard(); open(false) }
    Button((atLogin ? "✓ " : "") + Words.atLogin) {
      // registered only when the owner ticks it
      do { if atLogin { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() } } catch {}
      atLogin = SMAppService.mainApp.status == .enabled
    }
    Divider()
    Button(Words.quit) { NSApp.terminate(nil) }
  }
}

/** the Human window when no role's console answers (none made yet, or all removed): what a role is, and how to make one */
struct NoRoles: View {
  @ObservedObject var model: MachineModel
  @State private var copied = false
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(Words.noRolesTitle).font(.title2.weight(.semibold))
      Text(Words.noRolesBody).foregroundStyle(.secondary)
      Text(Words.makeOne).font(.headline).padding(.top, 10)
      Button(Words.create) { model.startWizard() }.buttonStyle(.borderedProminent).controlSize(.large)
      if let e = model.wizardError { Text(e).foregroundStyle(.red).font(.callout) }
      Text(Words.makeStep).padding(.top, 6)
      HStack(spacing: 10) {
        Text("./setup").font(.system(.body, design: .monospaced)).textSelection(.enabled)
          .padding(.horizontal, 10).padding(.vertical, 6)
          .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .quaternaryLabelColor).opacity(0.5)))
        Button(copied ? Words.copied : Words.copy) {
          NSPasteboard.general.clearContents(); NSPasteboard.general.setString("./setup", forType: .string); copied = true
        }
      }
      Text(Words.makeAfter).foregroundStyle(.secondary)
    }
    .fixedSize(horizontal: false, vertical: true)
    .frame(maxWidth: 520, alignment: .leading)
    .padding(40)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/** Human.app: this computer's page in a window, the dots in the menu bar */
struct HumanApp: App {
  @StateObject private var model = MachineModel()
  @State private var monitor = false
  @Environment(\.openWindow) private var openWindow
  init() {}
  var body: some Scene {
    Window("Human", id: "human") {
      Group {
        if let w = model.wizard { ConsoleView(url: w) }
        else if let url = model.url(monitor: monitor) { ConsoleView(url: url) } else if model.checked { NoRoles(model: model) } else { Color.clear }
      }
        .frame(minWidth: 900, minHeight: 600)
        .task { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert]); model.start() }
    }
    MenuBarExtra {
      MenuContent(model: model) { m in monitor = m; openWindow(id: "human"); NSApp.activate() }
    } label: { Image(nsImage: dotsImage(model.roles)) }
  }
}

/**
 * A role's own app: a window on its console, paired first; role.json sits beside the app in the role's folder. A plain
 * NSApplication whose delegate makes the window once launched (a SwiftUI scene, opened right after the app was rebuilt
 * or first registered, came up with no window at times: the process idle, the pairing never run).
 */
enum RoleWindowApp {
  /** called from main.swift's top level, which runs on the main thread */
  static func main() {
    MainActor.assumeIsolated {
      let app = NSApplication.shared
      let delegate = RoleWindow()
      app.delegate = delegate
      app.setActivationPolicy(.regular)
      withExtendedLifetime(delegate) { app.run() }
    }
  }
}

@MainActor
final class RoleWindow: NSObject, NSApplicationDelegate {
  private let role: RoleInfo? = {
    let file = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("role.json")
    return (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(RoleInfo.self, from: $0) }
  }()
  private var window: NSWindow?
  private let links = ConsoleView.Coordinator()
  private let pairing = Pairing()

  func applicationDidFinishLaunching(_ n: Notification) {
    let name = role?.name ?? "HH"
    NSApp.mainMenu = Self.menu(name)
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 820))
    web.navigationDelegate = links
    let w = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    w.title = name
    w.contentView = web
    w.contentMinSize = NSSize(width: 900, height: 600)
    w.setFrameAutosaveName("console")
    w.center()
    w.makeKeyAndOrderFront(nil)
    window = w
    NSApp.activate()
    guard let role else { NSLog("HH: no role.json beside the app"); return }
    Task {
      let paired = await pairing.ensure(role)
      if !paired { NSLog("HH: not paired with %@'s console on %d: %@", role.id, role.port, "\(PairPlan.of(role))") }
      web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(role.port)/")!))
    }
  }

  /** its own link (a browser's, the settings page's) while it is open: the page of permissions */
  func application(_ app: NSApplication, open urls: [URL]) {
    if urls.contains(where: { isGrants($0) && $0.scheme == Bundle.main.bundleIdentifier }) { Grants.openPage() }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

  /** what a window app needs: quit, and the edit keys the talk box takes (copy, paste, select all, undo) */
  private static func menu(_ name: String) -> NSMenu {
    let bar = NSMenu()
    let appItem = NSMenuItem(), edit = NSMenuItem()
    bar.addItem(appItem); bar.addItem(edit)
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: Lang.t("menu.quitApp", ["name": name]), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    let e = NSMenu(title: Lang.t("menu.edit"))
    for (title, sel, key) in [(Lang.t("menu.undo"), Selector(("undo:")), "z"), (Lang.t("menu.cut"), #selector(NSText.cut(_:)), "x"),
                              (Lang.t("menu.copy"), #selector(NSText.copy(_:)), "c"), (Lang.t("menu.paste"), #selector(NSText.paste(_:)), "v"),
                              (Lang.t("menu.selectAll"), #selector(NSText.selectAll(_:)), "a")] {
      e.addItem(withTitle: title, action: sel, keyEquivalent: key)
    }
    edit.submenu = e
    return bar
  }
}
