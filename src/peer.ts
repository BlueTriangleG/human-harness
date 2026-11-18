// Who connected to a unix socket: the kernel's record of the connecting process, not anything the client says.
import { execFile, spawn } from "node:child_process";
import type { Socket } from "node:net";

// Node has no getsockopt: the system's python reads it on a duplicate of the socket, handed over as fd 3 (fds 0-2 would
// be made blocking for the child, and that flag is shared with hhd's own descriptor). Never the role's configured python:
// the role can edit its config, and a python of its choosing could print any pid.
const PYTHON = "/usr/bin/python3";
const PEER_PID = `import socket, struct, sys
s = socket.socket(fileno=3)
print(struct.unpack("i", s.getsockopt(0, 2, 4))[0] if sys.platform == "darwin" else struct.unpack("3i", s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[0])`;   // LOCAL_PEERPID on macOS, SO_PEERCRED's pid on Linux

/** The pid of the process that connected `sock` */
export function peerPid(sock: Socket): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["-I", "-c", PEER_PID], { stdio: ["ignore", "pipe", "pipe", sock] });
    let out = "";
    child.stdout!.on("data", (d) => { out += d; });
    child.stderr!.on("data", (d) => { out += d; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 && /^\d+\s*$/.test(out) ? resolve(Number(out)) : reject(new Error(out.trim() || `exit ${code}`))));
  });
}

/** Whether `pid` descends from `root` (root itself does not). A pid no longer running is an error, not a no. */
export async function descendsFrom(pid: number, root: number): Promise<boolean> {
  const ps = await new Promise<string>((resolve, reject) => execFile("ps", ["-A", "-o", "pid=,ppid="], (e, out) => (e ? reject(e) : resolve(out))));
  const parent = new Map(ps.trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number) as [number, number]));
  if (!parent.has(pid)) throw new Error(`pid ${pid} is gone`);
  for (let p = parent.get(pid); p !== undefined && p > 1; p = parent.get(p)) if (p === root) return true;
  return false;
}
