// The roles' consoles, as HH.app's thin native layer needs them: where each one is, what each one's /api/summary says (the
// one read a console gives without the owner's token: how the role is, never what about), and pairing the app's own web view with a console so it can talk. The pages themselves are the web console's.
//
// A port is the account's that listens on it, read off the process (netstat names the pid, ps its user), never off what a
// role writes. A role of this account: a console this account's launchd runs, on a port this account listens on; it pairs
// by its own hh console --url, run as that job runs it (its token file is its own instance's). A role of another account:
// a folder under /Users/Shared/HH that belongs to the account listening on its port, named as its id, not an account that
// administers the machine, its id none of this account's roles has; it gets one more line in /Users/Shared/hh-console/
// <id>.owner (the owner writes it, the role only reads it; hh console --as sets it up), when that file is there and the
// owner's. From a role.json only id, name, account and port are read; nothing a role names is run or written to.
import CryptoKit
import Foundation
import WebKit

/** a role on this computer, as its folder's role.json or this account's launchd job says */
struct RoleInfo: Codable, Hashable {
  let id: String
  let name: String
  let account: String
  let port: Int
}

/** a role as its console's /api/summary says (machine.ts summaryOf); not answering, down */
struct RoleState {
  struct Today: Decodable { let stops: Int; let refusals: Int; let blocks: Int }
  struct Summary: Decodable { let up: Bool; let alertness: String?; let busy: Bool; let quota: Int?; let load: String?; let today: Today; let rulesErrors: Int }
  let info: RoleInfo
  let summary: Summary?
  var id: String { info.id }
  var name: String { info.name }
  var port: Int { info.port }
  var up: Bool { summary?.up ?? false }
  var alertness: String? { summary?.alertness }
  var busy: Bool { summary?.busy ?? false }
  var quota: Int? { summary?.quota }
  var load: String? { summary?.load }
  var today: Today { summary?.today ?? Today(stops: 0, refusals: 0, blocks: 0) }
  var rulesErrors: Int { summary?.rulesErrors ?? 0 }

  /** the same reading as the page's (js/machine.js stateOf) */
  enum Kind { case down, trouble, asleep, busy, idle }
  var kind: Kind {
    if !up { return .down }
    if today.stops + today.refusals + rulesErrors > 0 { return .trouble }
    if alertness == "asleep" { return .asleep }
    return busy ? .busy : .idle
  }
}

// Each key on its own, of its own type (machine.ts summaryFrom): the console is the role's process and can send anything.
// A key of another type is empty, not the whole summary lost; a count is 0 to 1_000_000 (their sum cannot overflow);
// what else it sends is not read: the role's id, name and port are RoleInfo's.
private func count(_ v: Int?) -> Int { min(max(v ?? 0, 0), 1_000_000) }

extension RoleState.Today {
  private enum K: String, CodingKey { case stops, refusals, blocks }
  init(from d: Decoder) throws {
    let c = try d.container(keyedBy: K.self)
    self.init(stops: count(try? c.decode(Int.self, forKey: .stops)), refusals: count(try? c.decode(Int.self, forKey: .refusals)),
              blocks: count(try? c.decode(Int.self, forKey: .blocks)))
  }
}

extension RoleState.Summary {
  private enum K: String, CodingKey { case up, alertness, busy, quota, load, today, rulesErrors }
  init(from d: Decoder) throws {
    let c = try d.container(keyedBy: K.self)
    let word = { (k: K) in (try? c.decode(String.self, forKey: k)).flatMap { $0.range(of: "^[a-z][a-z-]{0,23}$", options: .regularExpression) != nil ? $0 : nil } }
    let q = try? c.decode(Double.self, forKey: .quota)
    self.init(up: (try? c.decode(Bool.self, forKey: .up)) ?? false, alertness: word(.alertness), busy: (try? c.decode(Bool.self, forKey: .busy)) ?? false,
              quota: q.flatMap { $0.isFinite && $0 >= 0 && $0 <= 1_000_000 ? Int($0.rounded()) : nil },
              load: word(.load).flatMap { ["ok", "tight", "danger"].contains($0) ? $0 : nil },
              today: (try? c.decode(RoleState.Today.self, forKey: .today)) ?? RoleState.Today(stops: 0, refusals: 0, blocks: 0),
              rulesErrors: count(try? c.decode(Int.self, forKey: .rulesErrors)))
  }
}

enum Consoles {
  static let shared = URL(fileURLWithPath: "/Users/Shared/HH")
  static let tokenDir = URL(fileURLWithPath: "/Users/Shared/hh-console")
  private static let idOK = try! NSRegularExpression(pattern: "^[a-z0-9-]+$")
  static func validID(_ id: String) -> Bool { idOK.firstMatch(in: id, range: NSRange(id.startIndex..., in: id)) != nil }

  /** how a port, a folder and an account are read; the machine's own by default (the harness gives made-up ones) */
  struct Lookups {
    var me: uid_t = getuid()
    var listener: (Int) -> uid_t? = Consoles.listenerUid
    var folderOwner: (URL) -> uid_t? = { (try? FileManager.default.attributesOfItem(atPath: $0.path)[.ownerAccountID] as? NSNumber)?.uint32Value }
    var admin: (uid_t) -> Bool = Consoles.isAdmin
    var agents = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents")
    var shared = Consoles.shared
  }

  /** the uid of the process listening on 127.0.0.1:<port>: netstat names the pid, ps its user */
  static func listenerUid(_ port: Int) -> uid_t? {
    guard let table = run("/usr/sbin/netstat", ["-anv", "-p", "tcp"]) else { return nil }
    for line in table.split(separator: "\n") {
      let f = line.split(separator: " ", omittingEmptySubsequences: true)
      guard f.count > 10, f[3] == "127.0.0.1.\(port)", f[5] == "LISTEN" else { continue }
      guard let p = f.dropFirst(6).first(where: { $0.contains(":") }), let pid = p.split(separator: ":").last,
            let uid = run("/bin/ps", ["-o", "uid=", "-p", String(pid)]).flatMap({ UInt32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }) else { return nil }
      return uid
    }
    return nil
  }

  /** whether an account administers the machine (in the admin group): the owner's kind, never a role's own account */
  static func isAdmin(_ uid: uid_t) -> Bool {
    guard let g = getgrnam("admin")?.pointee.gr_gid, let out = run("/usr/bin/id", ["-G", String(uid)]) else { return true }
    return out.split(whereSeparator: \.isWhitespace).contains { gid_t($0) == g }
  }

  static func run(_ path: String, _ args: [String]) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return nil }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return p.terminationStatus == 0 ? String(decoding: data, as: UTF8.self) : nil
  }

  /** this account's launchd console jobs on a port it listens on: how each runs (old [node, main.ts] or HH.app's [HH, "--", node, main.ts]) and its role's id */
  struct Job { let id: String; let port: Int; let node: String; let code: String; let config: String }
  static func jobs(_ look: Lookups = Lookups()) -> [Job] {
    let files = (try? FileManager.default.contentsOfDirectory(at: look.agents, includingPropertiesForKeys: nil)) ?? []
    return files.filter { $0.pathExtension == "plist" }.compactMap { f in
      guard let d = NSDictionary(contentsOf: f), var args = d["ProgramArguments"] as? [String],
            let env = d["EnvironmentVariables"] as? [String: String], let port = Int(env["HH_CONSOLE_PORT"] ?? ""), let config = env["HH_CONFIG"] else { return nil }
      if args.count > 1 && args[1] == "--" { args.removeFirst(2) }
      guard args.count > 1, args[1].hasSuffix("/src/console/main.ts"), look.listener(port) == look.me else { return nil }
      let id = (try? Data(contentsOf: URL(fileURLWithPath: config))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["id"] as? String ?? ""
      return Job(id: id, port: port, node: args[0], code: String(args[1].dropLast("/src/console/main.ts".count)), config: config)
    }
  }

  /** another account's roles: a folder of the account listening on its port, named as its id, an id none of this account's roles has */
  static func folders(_ look: Lookups = Lookups()) -> [(RoleInfo, uid_t)] {
    let ours = Set(jobs(look).map(\.id))
    let dirs = (try? FileManager.default.contentsOfDirectory(at: look.shared, includingPropertiesForKeys: nil)) ?? []
    return dirs.compactMap { d in
      guard let data = try? Data(contentsOf: d.appendingPathComponent("role.json")), let r = try? JSONDecoder().decode(RoleInfo.self, from: data),
            validID(r.id), r.id == d.lastPathComponent, !ours.contains(r.id), (1...65535).contains(r.port),
            let uid = look.listener(r.port), uid != look.me, look.folderOwner(d) == uid else { return nil }
      return (r, uid)
    }
  }

  /** a console that answers, for the window and this computer's page: this account's first, then the roles' folders */
  static func anyPort() async -> Int? {
    for p in jobs().map(\.port) + folders().map(\.0.port) where await get("http://127.0.0.1:\(p)/api/pair/status") != nil { return p }
    return nil
  }

  static func get(_ url: String) async -> Data? {
    guard let u = URL(string: url) else { return nil }
    var req = URLRequest(url: u, timeoutInterval: 5)
    req.cachePolicy = .reloadIgnoringLocalCacheData
    guard let (data, res) = try? await URLSession.shared.data(for: req), (res as? HTTPURLResponse)?.statusCode == 200 else { return nil }
    return data
  }

  /** this computer's roles (this account's consoles, then the roles' folders), each with its console's summary */
  static func states(_ look: Lookups = Lookups()) async -> [RoleState] {
    let own = jobs(look).map { j in RoleInfo(id: j.id, name: shownName(j.id, look) ?? j.id, account: NSUserName(), port: j.port) }
    var out: [RoleState] = []
    for r in own + folders(look).map(\.0) where !out.contains(where: { $0.port == r.port }) {
      let s = await get("http://127.0.0.1:\(r.port)/api/summary").flatMap { try? JSONDecoder().decode(RoleState.Summary.self, from: $0) }
      out.append(RoleState(info: r, summary: s))
    }
    return out
  }

  /** a role of this account's name, as its app's role.json has it (~/Applications/HH/<id>, or the shared folder) */
  static func shownName(_ id: String, _ look: Lookups) -> String? {
    let home = FileManager.default.homeDirectoryForCurrentUser
    for d in [home.appendingPathComponent("Applications/HH/\(id)"), look.shared.appendingPathComponent(id)] {
      if let data = try? Data(contentsOf: d.appendingPathComponent("role.json")), let r = try? JSONDecoder().decode(RoleInfo.self, from: data) { return r.name }
    }
    return nil
  }
}

/** how a role is paired, decided off the port's account (Consoles); none: not at all, and why */
enum PairPlan: Equatable {
  case own(port: Int)
  case shared(id: String, port: Int)
  case none(String)

  static func of(_ r: RoleInfo, _ look: Consoles.Lookups = Consoles.Lookups()) -> PairPlan {
    guard let uid = look.listener(r.port) else { return .none("nobody listens on \(r.port)") }
    if uid == look.me { return Consoles.jobs(look).contains { $0.port == r.port } ? .own(port: r.port) : .none("not a console this account's launchd runs") }
    guard Consoles.folders(look).contains(where: { $0.0.id == r.id && $0.0.port == r.port && $0.1 == uid }) else { return .none("no folder of the account on that port names it") }
    return look.admin(uid) ? .none("an account that administers the machine") : .shared(id: r.id, port: r.port)
  }
}

/**
 * Pairs the app's web views (they share the default website data store) with a console, when it asks for a token and
 * this store is not paired with it yet. A pairing address is loaded in a web view no one sees; the page keeps the token
 * in its own origin's storage, as it does in a browser, and sends it in a header.
 */
@MainActor
final class Pairing: NSObject, WKNavigationDelegate {
  private let web = WKWebView(frame: .zero)
  private var done: CheckedContinuation<Void, Never>?

  /** pair with this role's console unless already paired; false when it cannot be (the page then says what to type) */
  func ensure(_ r: RoleInfo) async -> Bool {
    // just installed, the console may still be starting: wait for it to answer, up to 20 seconds
    var answer = await pageStatus(port: r.port)
    for _ in 0..<10 where answer == nil { try? await Task.sleep(for: .seconds(2)); answer = await pageStatus(port: r.port) }
    guard let status = answer else { return false }
    if status.paired || !status.enabled || !status.token { return status.enabled }
    let url: URL?
    switch PairPlan.of(r) {
    case .own(let port): url = ownCommand(port: port)
    case .shared(let id, let port): url = await sharedToken(id: id, port: port)
    case .none: url = nil
    }
    guard let url else { return false }
    await load(url)
    return await pageStatus(port: r.port)?.paired ?? false
  }

  private struct Status: Decodable { let enabled: Bool; let token: Bool; let paired: Bool }

  /** /api/pair/status as this store sees it: the token from that origin's storage, in the header */
  private func pageStatus(port: Int) async -> Status? {
    await load(URL(string: "http://127.0.0.1:\(port)/api/pair/status")!)
    let js = "const r = await fetch('/api/pair/status', { headers: { 'x-hh-owner': localStorage.getItem('hh_owner') || '' } }); return await r.text();"
    guard let text = try? await web.callAsyncJavaScript(js, contentWorld: .page) as? String else { return nil }
    return try? JSONDecoder().decode(Status.self, from: Data(text.utf8))
  }

  private func load(_ url: URL) async {
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
      done = c
      web.navigationDelegate = self
      web.load(URLRequest(url: url))
    }
    try? await Task.sleep(for: .milliseconds(600))   // the pairing page checks the token, keeps it and moves on
  }

  nonisolated func webView(_ w: WKWebView, didFinish n: WKNavigation!) { Task { @MainActor in done?.resume(); done = nil } }
  nonisolated func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { Task { @MainActor in done?.resume(); done = nil } }
  nonisolated func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { Task { @MainActor in done?.resume(); done = nil } }

  /**
   * a role of this account: its own `hh console --url`, run the way its launchd job runs it. Not with CLAUDECODE: `open`
   * hands the opener's environment to the app, and opened from a Claude Code session the command took the app for a
   * role's own session and refused (that check guards against mistakes, not the owner's own app).
   */
  private func ownCommand(port: Int) -> URL? {
    guard let job = Consoles.jobs().first(where: { $0.port == port }) else { return nil }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: job.node)
    p.arguments = [job.code + "/src/cli.ts", "console", "--url"]
    var env = ProcessInfo.processInfo.environment
    env["CLAUDECODE"] = nil
    env["HH_CONFIG"] = job.config
    p.environment = env
    let out = Pipe(), err = Pipe()
    p.standardOutput = out
    p.standardError = err
    guard (try? p.run()) != nil else { NSLog("HH: cannot run %@", job.node); return nil }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    let why = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    p.waitUntilExit()
    if p.terminationStatus != 0 { NSLog("HH: hh console --url for the console on %d failed: %@", port, why); return nil }
    return URL(string: String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
  }

  /** a role of another account: one more line in its fixed token file, when the file is there and the owner's */
  private func sharedToken(id: String, port: Int) async -> URL? {
    guard Consoles.validID(id) else { return nil }
    let file = Consoles.tokenDir.appendingPathComponent("\(id).owner")
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: file.path), (attrs[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
          let old = try? String(contentsOf: file, encoding: .utf8), let token = Self.hex(32), let code = Self.hex(16) else { return nil }
    let hash = SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
    let lines = old.split(separator: "\n").map(String.init).suffix(7) + [hash]
    guard (try? (lines.joined(separator: "\n") + "\n").write(to: file, atomically: true, encoding: .utf8)) != nil else { return nil }
    // the address carries a one-time code the console is given for the token, never the token (owner.ts PAIR_CODE_MS)
    let base = "http://127.0.0.1:\(port)"
    var req = URLRequest(url: URL(string: base + "/api/pair/code")!, timeoutInterval: 5)
    req.httpMethod = "POST"
    for (k, v) in ["Origin": base, "Content-Type": "application/json", "x-hh-console": "1"] { req.setValue(v, forHTTPHeaderField: k) }
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token, "code": code])
    guard let (_, res) = try? await URLSession.shared.data(for: req), (res as? HTTPURLResponse)?.statusCode == 200 else { return nil }
    return URL(string: base + "/pair#c=\(code)")
  }

  /** n random bytes in hex */
  private static func hex(_ n: Int) -> String? {
    var bytes = [UInt8](repeating: 0, count: n)
    guard SecRandomCopyBytes(kSecRandomDefault, n, &bytes) == errSecSuccess else { return nil }
    return bytes.map { String(format: "%02x", $0) }.joined()
  }
}
