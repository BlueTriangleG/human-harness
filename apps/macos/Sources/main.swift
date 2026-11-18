// The one executable of every HH app. Started by launchd as `HH -- /program …` it is the role's launcher (launcher.c): the
// program runs as its child, so macOS counts the program's privacy requests against this app. Opened by the owner, it is a
// window: Human.app (ai.hh.human) on this computer's roles; a role's own app on that role's console (UI/Apps.swift), after
// its permission page (Grants.swift) while one of its grants is still off.
import Foundation

let args = CommandLine.arguments
if args.count > 1 && args[1] == "--" { exit(hh_launch(CommandLine.argc, CommandLine.unsafeArgv)) }
if args.count > 1 && args[1] == "--grants-status" { FileHandle.standardOutput.write(Grants.json(Grants.now())); exit(0) }
if Bundle.main.bundleIdentifier == "ai.hh.human" {
  HumanApp.main()
} else {
  let granted = Grants.now(), page = args.contains("--grants")
  if page && granted.all {
    // nothing to ask: tell whoever waits on the status file, and go
    if let i = args.firstIndex(of: "--status"), i + 1 < args.count { try? Grants.json(granted).write(to: URL(fileURLWithPath: args[i + 1])) }
    exit(0)
  }
  if page || (!granted.all && !args.contains("--window")) { GrantsApp.run() } else { RoleWindowApp.main() }
}
