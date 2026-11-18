"""Linux: this machine's readings for scripts that watch it (the load guard), from /proc and /sys. The same names as
machine_darwin.py. Linux has no compressor of macOS's kind: zram's memory in use stands for it where there is zram, and
the pressure level comes from the kernel's pressure stall information."""
import os
import time

PROC, SYS = "/proc", "/sys"   # a test points them at a made-up tree
PS = ("ps", "-eo", "user=,pid=,rss=,command=")
DISK = "/"


def _read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


def _meminfo():
    """/proc/meminfo in kB"""
    out = {}
    for line in _read(PROC + "/meminfo").splitlines():
        k, _, v = line.partition(":")
        if v.split():
            out[k] = int(v.split()[0])
    return out


def total_mb():
    return _meminfo().get("MemTotal", 16 * 1024 * 1024) // 1024


def ncpu():
    return os.cpu_count() or 1


def pressure():
    """1 normal, 2 warning, 4 critical, as macOS has them: some stall over 10% of the last 10 seconds warns, a full one is critical"""
    avg = {}
    for line in _read(PROC + "/pressure/memory").splitlines():
        kind, *fields = line.split()
        avg[kind] = float(dict(f.split("=") for f in fields).get("avg10", 0))
    if not avg:
        return None
    return 4 if avg.get("full", 0) >= 10 else 2 if avg.get("some", 0) >= 10 else 1


def avail_pct():
    m = _meminfo()
    return round(100 * m["MemAvailable"] / m["MemTotal"]) if m.get("MemTotal") and "MemAvailable" in m else None


def _zram():
    """(memory zram uses, its limit) in bytes over every zram device; limit 0 = none set"""
    used = limit = 0
    block = SYS + "/block"
    for d in sorted(os.listdir(block)) if os.path.isdir(block) else []:
        f = _read(f"{block}/{d}/mm_stat").split() if d.startswith("zram") else []
        if len(f) >= 4:
            used, limit = used + int(f[2]), limit + int(f[3])
    return used, limit


def compressed_bytes():
    return _zram()[0]


def segments():
    """zram's memory in use against its limit (none without a limit set)"""
    used, limit = _zram()
    return (used, limit) if limit else (None, None)


def boot_sec():
    for line in _read(PROC + "/stat").splitlines():
        if line.startswith("btime "):
            return int(line.split()[1])
    return None


def uptime():
    """a clock of the whole system that stops while it is suspended"""
    return time.clock_gettime(time.CLOCK_MONOTONIC)


def swap_used_gb():
    m = _meminfo()
    return (m["SwapTotal"] - m["SwapFree"]) / 1024 / 1024 if "SwapTotal" in m and "SwapFree" in m else None


def vm():
    """page size, pages in the compressor (none: compressed_bytes says it), swap-ins so far, free pages"""
    v = dict(line.split() for line in _read(PROC + "/vmstat").splitlines() if len(line.split()) == 2)
    return dict(page=os.sysconf("SC_PAGE_SIZE"), comp_pages=0, swapins=int(v.get("pswpin", 0)), free=int(v.get("nr_free_pages", 0)))


def footprint_mb(pid):
    """resident plus swapped-out memory, macOS's footprint as near as Linux has it"""
    st = {}
    for line in _read(f"{PROC}/{pid}/status").splitlines():
        k, _, v = line.partition(":")
        if v.split():
            st[k] = v.split()[0]
    return (int(st["VmRSS"]) + int(st.get("VmSwap", 0))) // 1024 if "VmRSS" in st else None
