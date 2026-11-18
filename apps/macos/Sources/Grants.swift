// The role's app asks for its own privacy grants: it is their owner, macOS counts every job it starts against it. One page,
// a row each (Full Disk Access, Screen & System Audio Recording, Accessibility), each with its button and a ✓ read every
// second; when all three are on it closes by itself, nobody has to come back and say so.
//   HH --grants [--status <file>]  the page (install and the switch open it for the owner; the file gets the state each second)
//   HH --grants-status             what this app may do now, as JSON: the page runs it as its child every second, a new
//                                  process reading each grant afresh (a running one keeps its first answer for the screen)
// Opened by the owner with a grant still off, the role's app shows this page first (main.swift).
import AppKit
import ApplicationServices
import CoreGraphics
import SwiftUI

struct GrantState: Codable, Equatable {
  var fda = false, screen = false, ax = false
  var all: Bool { fda && screen && ax }
}

enum Grants {
  /** what this process may do: Full Disk Access is reading the user's TCC.db, which only it allows */
  static func now() -> GrantState {
    let db = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/com.apple.TCC/TCC.db")
    let fda = (try? FileHandle(forReadingFrom: db)).map { try? $0.close(); return true } ?? false
    return GrantState(fda: fda, screen: CGPreflightScreenCaptureAccess(), ax: AXIsProcessTrusted())
  }

  /** what this app may do, read by a new process of it */
  static func fresh() -> GrantState {
    let p = Process(), out = Pipe()
    p.executableURL = Bundle.main.executableURL
    p.arguments = ["--grants-status"]
    p.standardOutput = out
    guard (try? p.run()) != nil else { return GrantState() }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (try? JSONDecoder().decode(GrantState.self, from: data)) ?? GrantState()
  }

  static func json(_ s: GrantState) -> Data { (try? JSONEncoder().encode(s)) ?? Data("{}".utf8) }

  /** the page, as a new instance of this app: what the role's window opens for <bundle id>://grants (the console's settings page) */
  static func openPage() {
    let c = NSWorkspace.OpenConfiguration()
    c.arguments = ["--grants"]
    c.createsNewApplicationInstance = true
    NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: c)
  }

  static func settings(_ pane: String) {
    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!)
  }
}

/** the page's words, in the role's language (Lang.swift) */
private enum Say {
  static let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "HH"
  static var title: String { Lang.t("grants.title", ["name": name]) }
  static var intro: String { Lang.t("grants.intro", ["name": name]) }
  static var fda: String { Lang.t("grants.fda") }
  static var fdaWhy: String { Lang.t("grants.fdaWhy") }
  static var fdaHow: String { Lang.t("grants.fdaHow") }
  static var screen: String { Lang.t("grants.screen") }
  static var screenWhy: String { Lang.t("grants.screenWhy") }
  static var ax: String { Lang.t("grants.ax") }
  static var axWhy: String { Lang.t("grants.axWhy") }
  static var ask: String { Lang.t("grants.ask") }
  static var open: String { Lang.t("grants.open") }
  static var flip: String { Lang.t("grants.flip", ["name": name]) }
  static var done: String { Lang.t("grants.done") }
  static var later: String { Lang.t("grants.later") }
  static var quit: String { Lang.t("quit") }
}

@MainActor
final class GrantsModel: ObservableObject {
  @Published var state = GrantState()
  @Published var asked: Set<String> = []
  let status: URL?
  let then: () -> Void
  private var started = false

  init(status: URL?, then: @escaping () -> Void) { self.status = status; self.then = then }

  func start() {
    guard !started else { return }
    started = true
    Task {
      while true {
        let s = await Task.detached { Grants.fresh() }.value
        state = s
        if let status { try? Grants.json(s).write(to: status, options: .atomic) }
        if s.all { try? await Task.sleep(for: .seconds(2)); then(); return }
        try? await Task.sleep(for: .seconds(1))
      }
    }
  }

  func askScreen() { asked.insert("screen"); if !CGRequestScreenCaptureAccess() { Grants.settings("Privacy_ScreenCapture") } }
  func askAx() { asked.insert("ax"); _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary) }
  func askFda() { asked.insert("fda"); Grants.settings("Privacy_AllFiles") }
}

struct GrantsView: View {
  @ObservedObject var model: GrantsModel
  let later: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text(Say.title).font(.title2.bold())
      Text(Say.intro).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      row(Say.fda, Say.fdaWhy, on: model.state.fda, hint: Say.fdaHow, icon: true, action: model.askFda)
      row(Say.screen, Say.screenWhy, on: model.state.screen, hint: model.asked.contains("screen") ? Say.flip : nil, action: model.askScreen)
      row(Say.ax, Say.axWhy, on: model.state.ax, hint: model.asked.contains("ax") ? Say.flip : nil, action: model.askAx)
      HStack {
        if model.state.all { Label(Say.done, systemImage: "checkmark.seal.fill").foregroundStyle(.green) }
        Spacer()
        Button(Say.later, action: later)
      }
    }
    .padding(24)
    .frame(width: 520)
  }

  private func row(_ name: String, _ why: String, on: Bool, hint: String?, icon: Bool = false, action: @escaping () -> Void) -> some View {
    HStack(alignment: .center, spacing: 12) {
      if icon {
        // the app itself, to drag into the Full Disk Access list (that list has no request a program can make)
        Image(nsImage: NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath)).resizable().frame(width: 40, height: 40)
          .onDrag { NSItemProvider(object: Bundle.main.bundleURL as NSURL) }
      } else {
        Color.clear.frame(width: 40, height: 40)
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(name).font(.headline)
        Text(why).font(.callout).foregroundStyle(.secondary)
        if let hint, !on { Text(hint).font(.callout) }
      }
      Spacer()
      if on {
        Image(systemName: "checkmark.circle.fill").font(.title2).foregroundStyle(.green)
      } else {
        Button(icon ? Say.open : Say.ask, action: action).controlSize(.large)
      }
    }
  }
}

/**
 * HH --grants: the page alone. Opened by the owner (no --grants), the role's window follows once it is done or put off.
 * Its window is made by hand when the app has launched (a SwiftUI scene may come up without one), and closing it quits.
 */
final class GrantsApp: NSObject, NSApplicationDelegate {
  private var window: NSWindow?

  static func run() -> Never {
    let app = NSApplication.shared, me = GrantsApp()
    app.delegate = me
    app.setActivationPolicy(.regular)
    let menu = NSMenu(), item = NSMenuItem()
    item.submenu = NSMenu()
    item.submenu!.addItem(withTitle: Say.quit, action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    menu.addItem(item)
    app.mainMenu = menu
    app.run()
    exit(0)
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    let args = CommandLine.arguments
    let status = args.firstIndex(of: "--status").flatMap { args.indices.contains($0 + 1) ? URL(fileURLWithPath: args[$0 + 1]) : nil }
    let alone = args.contains("--grants")
    let next = {
      // the owner opened the app: its own window comes next, as a new instance of it
      guard !alone else { NSApp.terminate(nil); return }
      let c = NSWorkspace.OpenConfiguration()
      c.arguments = ["--window"]
      c.createsNewApplicationInstance = true
      NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: c) { _, _ in DispatchQueue.main.async { NSApp.terminate(nil) } }
    }
    let model = GrantsModel(status: status, then: next)
    let w = NSWindow(contentRect: .zero, styleMask: [.titled, .closable], backing: .buffered, defer: false)
    w.title = Say.title
    w.contentView = NSHostingView(rootView: GrantsView(model: model, later: next))
    w.setContentSize(w.contentView!.fittingSize)
    w.center()
    w.makeKeyAndOrderFront(nil)
    window = w
    NSApp.activate()
    model.start()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
}
