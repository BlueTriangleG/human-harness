"""macOS: this machine's readings for scripts that watch it (the load guard). machine_linux.py has the same names.

Read through the system's own calls (sysctlbyname, proc_pid_rusage) rather than by starting programs: when the machine
is at its slowest a subprocess times out and its default reads as "all is well"."""
import ctypes
import re
import subprocess
import time

GB = 1024 ** 3
PS = ("ps", "-axo", "user=,pid=,rss=,command=")
DISK = "/System/Volumes/Data"


def sh(*a, timeout=10):
    try:
        return subprocess.run(a, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ""


_LIBC = ctypes.CDLL("/usr/lib/libc.dylib", use_errno=True)


def _sysctl_raw(name, size):
    buf = ctypes.create_string_buffer(size)
    n = ctypes.c_size_t(size)
    if _LIBC.sysctlbyname(name.encode(), buf, ctypes.byref(n), None, ctypes.c_size_t(0)) != 0:
        return None
    return buf.raw[:n.value]


def sysctl(name, default=None):
    raw = _sysctl_raw(name, 8)
    if raw is None:
        v = sh("sysctl", "-n", name).strip()
        try: return int(v)
        except ValueError: return default
    return int.from_bytes(raw, "little", signed=False) if len(raw) in (4, 8) else default


def total_mb():
    return (sysctl("hw.memsize") or 16 * GB) // 1024 // 1024


def ncpu():
    return sysctl("hw.ncpu", 1)


def pressure():
    """the system's memory pressure level: 1 normal, 2 warning, 4 critical (None: unread)"""
    return sysctl("kern.memorystatus_vm_pressure_level")


def avail_pct():
    return sysctl("kern.memorystatus_level")


def compressed_bytes():
    return sysctl("vm.compressor_bytes_used")


def segments():
    """the compressor's segments in use and its limit"""
    return sysctl("vm.compressor.segment.total"), sysctl("vm.compressor.segment.limit")


def boot_sec():
    raw = _sysctl_raw("kern.boottime", 16)  # struct timeval
    return int.from_bytes(raw[:8], "little") if raw and len(raw) >= 8 else None


def uptime():
    """a clock of the whole system that stops while it sleeps"""
    return time.clock_gettime(time.CLOCK_UPTIME_RAW)


def swap_used_gb():
    raw = _sysctl_raw("vm.swapusage", 32)  # struct xsw_usage: total, avail, used (uint64)...
    if raw and len(raw) >= 24:
        return int.from_bytes(raw[16:24], "little") / GB
    m = re.search(r"used = ([0-9.]+)M", sh("sysctl", "-n", "vm.swapusage"))
    return float(m.group(1)) / 1024 if m else None


def vm():
    """page size, pages in the compressor, swap-ins so far, free pages"""
    out = sh("vm_stat")
    ps = int(re.search(r"page size of (\d+)", out).group(1)) if "page size" in out else 16384
    g = lambda k: int(re.search(re.escape(k) + r":\s+(\d+)", out).group(1)) if re.search(re.escape(k) + r":\s+(\d+)", out) else 0
    return dict(page=ps, comp_pages=g("Pages occupied by compressor"), swapins=g("Swapins"), free=g("Pages free"))


# phys_footprint (Activity Monitor's Memory column): resident plus the compressed and swapped-out private memory.
# One proc_pid_rusage call, about 2 ms for every process together; only this user's processes can be read.
class _RUsage(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(n, ctypes.c_uint64) for n in (
        "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups", "pageins",
        "wired_size", "resident_size", "phys_footprint", "proc_start_abstime", "proc_exit_abstime")]


try:
    _libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
    _libproc.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.POINTER(_RUsage)]
except (OSError, AttributeError):
    _libproc = None


def footprint_mb(pid):
    if _libproc is None:
        return None
    ru = _RUsage()
    if _libproc.proc_pid_rusage(pid, 0, ctypes.byref(ru)) != 0:  # 0 = RUSAGE_INFO_V0
        return None
    return ru.phys_footprint // 1024 // 1024
