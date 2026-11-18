"""machine_linux.py on a made-up /proc and /sys (python3 test_machine_linux.py <load.py>), then load.py's sample on it."""
import importlib.util, json, os, sys, tempfile
tmp = tempfile.mkdtemp()
os.environ.update({k: tmp for k in ("HH_WORKSPACE", "HH_STATE_DIR", "HH_MODULE_DIR", "HH_MODULE_STATE")},
                  HH_ROLE_ID="t", HH_ME="aqing", HH_OWNER="zhou", HH_TZ="UTC", HH_LANG="en", HH_BIN=tmp + "/no-hh",
                  HH_MODULE_CONFIG=json.dumps({"ownerUser": "zhou"}), USER="aqing")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "_lib"))
import machine_linux as M


def put(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


M.PROC, M.SYS = tmp + "/proc", tmp + "/sys"
put(M.PROC + "/meminfo", "MemTotal:       16384000 kB\nMemFree:          100000 kB\nMemAvailable:    4096000 kB\nSwapTotal:       8388608 kB\nSwapFree:        6291456 kB\n")
put(M.PROC + "/pressure/memory", "some avg10=12.50 avg60=3.00 avg300=1.00 total=123\nfull avg10=0.40 avg60=0.10 avg300=0.00 total=45\n")
put(M.PROC + "/vmstat", "nr_free_pages 25000\npswpin 777\npswpout 900\n")
put(M.PROC + "/stat", "cpu  1 2 3\nbtime 1763300000\n")
put(M.PROC + "/4242/status", "Name:\tffmpeg\nVmRSS:\t  3072000 kB\nVmSwap:\t  1024000 kB\n")
put(M.SYS + "/block/zram0/mm_stat", "1000 400 536870912 2147483648 0 0 0 0\n")
put(M.SYS + "/block/sda/stat", "x\n")
assert M.total_mb() == 16000
assert M.avail_pct() == 25
assert M.swap_used_gb() == 2.0
assert M.pressure() == 2
put(M.PROC + "/pressure/memory", "some avg10=40.00 avg60=3.00 avg300=1.00 total=123\nfull avg10=11.00 avg60=0.10 avg300=0.00 total=45\n")
assert M.pressure() == 4
assert M.vm()["swapins"] == 777 and M.vm()["free"] == 25000
assert M.boot_sec() == 1763300000
assert M.compressed_bytes() == 536870912 and M.segments() == (536870912, 2147483648)
assert M.footprint_mb(4242) == 4000 and M.footprint_mb(1) is None
os.remove(M.PROC + "/pressure/memory")
assert M.pressure() is None, "no pressure stall information: unread, not normal"

spec = importlib.util.spec_from_file_location("L", sys.argv[1]); L = importlib.util.module_from_spec(spec); spec.loader.exec_module(L)
L.M, L.boot_sec, L.footprint_mb = M, M.boot_sec, M.footprint_mb
L.sh = lambda *a, **k: "aqing 4242 3072000 /usr/bin/ffmpeg -i x\nzhou 5 2097152 /usr/lib/firefox\n" if a[:2] == ("ps", "-eo") else ""
s, mine = L.sample()
assert (s["total_mb"], s["avail_pct"], s["swap_gb"], s["seg_pct"], s["comp_gb"], s["pressure"]) == (16000, 25, 2.0, 25, 0.5, 1), s
assert s["mine_gb"] == 3.9 and s["others_gb"] == {"zhou": 2.0} and s["unknown"] == ["the pressure level"], s
print("ok")
