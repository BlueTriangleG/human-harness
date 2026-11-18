#!/usr/bin/env python3
"""感官层 bili 源（主人 2026-10-27 15:19 准的）：B站有人回复我、@我、私信我就叫醒主会话；赞不叫。
每行一个 JSON 事件 {id, text, body}，感官层按 id 去重。只读，走 bili 插件命令行。

  bili_events.py [reply]   回复 / @（senses.json 的 bili 源）
  bili_events.py dm        私信（senses.json 的 bili_dm 源，主人 2026-10-29 定）：
                           会话最后一条是对方发的、且这条（msg_key）没提醒过 → 提醒。不看「未读」：
                           未读被清零（网页上看了、或我自己 dmRead 过）但没回的，以前就漏了。
                           接口出错（登录失效 / 风控 / 超时）→ 什么都不输出、退出码 2，感官层不会把它当成「没私信」，
                           也不推进去重；连续失败 DOWN_AFTER 次后每天额外报一条「接口不可用」。"""
import datetime, hashlib, json, os, subprocess, sys, time

from hh_env import words

say = words(__file__)

WS = os.environ["HH_WORKSPACE"]
BILI = os.environ.get("BILI_BIN") or os.path.join(os.environ["HH_MODULE_DIR"], "bin/bili")   # BILI_BIN：测试用，换成假的 bili
# the private messages' health record: config healthFile (relative to the workspace), else in the module's state
_HEALTH = json.loads(os.environ.get("HH_MODULE_CONFIG") or "{}").get("healthFile")
HEALTH = os.environ.get("BILI_DM_HEALTH") or (os.path.join(WS, _HEALTH) if _HEALTH else os.path.join(os.environ["HH_MODULE_STATE"], "bili_dm_health.json"))
OWNER = os.environ.get("HH_OWNER") or say("ownerFallback")
MAX_AGE = 48 * 3600     # 只提醒最近这么久的最后一条，上线时别把陈年旧账一次叫醒
MAX_PER_RUN = 5
DOWN_AFTER = 3
# 限流（「请求过于频繁」）不是接口坏了：一天零星几十次，下一分钟就好（11-06 查的，11-04 那次「接口不可用」多半就是连撞 3 次限流的误报）。
# 所以限流不算进连续失败；撞上以后歇 RATE_COOLDOWN 秒再查（少撞几次）；连着限流超过 RATE_ALERT_AFTER 才报不可用
# the server's own words for it in either language (texts*.json: 请求太频繁 / too many requests, …太频繁 / … too often), and the codes
RATE_LIMIT_MARKS = ("频繁", "too many requests", "too often", "-799", "-412")
RATE_COOLDOWN = 180
RATE_ALERT_AFTER = 15 * 60


def call(*args):
    """-> (data, err)。超时、非 JSON、退出码非 0、ok:false 都算 err（文本尽量带接口给的原因和建议）。"""
    try:
        r = subprocess.run([BILI, *args], capture_output=True, text=True, timeout=90, cwd=WS)
    except Exception as e:
        return None, "%s: %s" % (type(e).__name__, e)
    out = r.stdout
    try:
        d = json.loads(out[out.index("{"):]) if "{" in out else None
    except ValueError:
        d = None
    if not isinstance(d, dict):
        return None, (say("exitCode") % (r.returncode, (r.stderr or out or say("noOutput")).strip()[-200:]))
    if d.get("ok") is False or r.returncode != 0:
        return None, "%s %s" % (d.get("error") or say("failed"), d.get("hint") or "")
    return d, None


def emit(eid, text, body):
    print(json.dumps({"id": eid, "text": text[:190], "body": body[:1500]}, ensure_ascii=False))


# ---------- 私信 ----------
def msg_key(s):
    """这个会话最后一条消息的唯一键：msg_key（2026-10-29 实测每个会话都有）→ msg_seqno → 时间+文本哈希。"""
    return (str(s.get("last_msg_key") or "") or str(s.get("last_seq") or "")
            or "%s-%s" % (s.get("last_ts") or 0, hashlib.sha1(str(s.get("last") or "").encode()).hexdigest()[:8]))


def dm_events(sessions, now):
    """会话列表 -> 该提醒的事件（最新的在前，最多 MAX_PER_RUN 条）。纯函数，测试直接喂数据。"""
    rows = []
    for s in sessions or []:
        ts = int(s.get("last_ts") or 0)
        if (s.get("last_from_me") or s.get("official") or not s.get("uid") or not s.get("last")
                or ts <= 0 or now - ts > MAX_AGE):
            continue
        rows.append((ts, s))
    out = []
    for ts, s in sorted(rows, key=lambda r: -r[0])[:MAX_PER_RUN]:
        who = s.get("name") or s.get("uid")
        last = str(s.get("last") or "")
        when = s.get("time") or ""
        out.append({"id": "bili-dm-%s-%s" % (s["uid"], msg_key(s)),
                    "text": say("dmText") % (who, last),
                    "body": say("dmBody")
                            % (who, when, last, who)})
    return out


def load_health():
    try:
        d = json.load(open(HEALTH, encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_health(h):
    os.makedirs(os.path.dirname(HEALTH), exist_ok=True)
    tmp = HEALTH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(h, fh, ensure_ascii=False)
    os.replace(tmp, HEALTH)


def rate_limited(err):
    return any(m in (err or "") for m in RATE_LIMIT_MARKS)


def record_health(err, now):
    """成功清零；失败累加。连续 DOWN_AFTER 次后，当天第一次返回一条「接口不可用」事件，否则 None。
    限流另算：不累加失败，记下从什么时候开始限流、歇到什么时候；连着限流超过 RATE_ALERT_AFTER 才报。"""
    h = load_health()
    if not err:
        if h.get("fails") or h.get("rl_since") or h.get("cooldown_until"):
            save_health({"fails": 0, "last_alert_day": h.get("last_alert_day")})
        return None
    today = datetime.datetime.fromtimestamp(now).strftime("%Y-%m-%d")
    if rate_limited(err):
        h.setdefault("rl_since", now)
        h["cooldown_until"] = now + RATE_COOLDOWN
        ev = None
        if now - h["rl_since"] >= RATE_ALERT_AFTER and h.get("last_alert_day") != today:
            h["last_alert_day"] = today
            # system：脚本自己生成的系统提示（只带接口的报错，不带谁的私信），控制台不当私聊遮（11-12 闸门）
            ev = {"id": "bili-dm-down-" + today, "system": True,
                  "text": say("dmRateText") % err[:120],
                  "body": say("dmRateBody") % ((now - h["rl_since"]) // 60, err[:300])}
        save_health(h)
        return ev
    h.pop("rl_since", None)
    h.pop("cooldown_until", None)
    h["fails"] = int(h.get("fails") or 0) + 1
    h.setdefault("first_fail", now)
    ev = None
    if h["fails"] >= DOWN_AFTER and h.get("last_alert_day") != today:
        h["last_alert_day"] = today
        ev = {"id": "bili-dm-down-" + today, "system": True,
              "text": say("dmDownText") % err[:120],
              "body": say("dmDownBody") % (h["fails"], err[:300])}
    save_health(h)
    return ev


def main_dm():
    now = time.time()
    if float(load_health().get("cooldown_until") or 0) > now:
        return 0   # 刚撞上限流，歇着：不发请求、不输出（感官层的 seen 只增不减，空输出不会丢私信）
    d, err = call("dm_sessions", "num=50")
    if err:
        print("bili_dm UNAVAILABLE: " + err, file=sys.stderr)
        ev = record_health(err, now)
        if ev:
            emit(ev["id"], ev["text"], ev["body"])
            return 0
        return 2
    record_health(None, now)
    for ev in dm_events(d.get("sessions"), now):
        emit(ev["id"], ev["text"], ev["body"])
    return 0


# ---------- 回复 / @ ----------
def main_reply():
    for kind, label in (("reply", say("repliedLabel")), ("at", say("mentionedLabel"))):
        d, err = call("notifications", "kind=" + kind, "num=20")
        if err:
            print("bili %s UNAVAILABLE: %s" % (kind, err), file=sys.stderr)
            continue
        for n in d.get("items", []) or []:
            rid = n.get("rpid") or n.get("id") or (str(n.get("mid")) + str(n.get("time")))
            emit("bili-%s-%s" % (kind, rid),
                 say("replyText") % (n.get("user"), label, n.get("text", "")),
                 say("replyBody")
                 % (n.get("user"), n.get("time"), label, n.get("text", ""), n.get("my_text", ""), n.get("url", ""),
                    OWNER, n.get("bvid"), n.get("rpid"), n.get("root")))
    return 0


if __name__ == "__main__":
    sys.exit(main_dm() if sys.argv[1:2] == ["dm"] else main_reply())
