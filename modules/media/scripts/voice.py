#!/opt/homebrew/bin/python3
"""你的嗓子：用 Fish Audio 把一段话变成语音条（ogg/opus），打印文件路径。

用法：
  /opt/homebrew/bin/python3 scripts/voice.py say "要说的话"          # 生成，打印 ogg 路径
  /opt/homebrew/bin/python3 scripts/voice.py say "..." --voice chouxiang  # 玩抽象用赛马娘；也可填音色 id
  一行一句，行内空格当逗号；脚本会自动补标点和 [break] 停顿（--raw 关掉）。
  /opt/homebrew/bin/python3 scripts/voice.py usage                    # 看这个月说了多少字

生成后用 message(action=send, media=<路径>, asVoice=true) 发出去。
密钥在 HH 的 secrets.json（fishAudioKey），别打印、别提交；音色在实例配置 modules.media.voices。
"""
import argparse, datetime, hashlib, json, os, re, socket, subprocess, sys, time, urllib.request, urllib.error

from hh_env import hh, words

say = words(__file__)

# the Fish Audio key: config keyFile (relative to the workspace, or ~ / absolute) and its field keyField, else HH's
# secrets file and fishAudioKey
SECRETS = os.path.join(hh.workspace, os.path.expanduser(hh.config["keyFile"])) if hh.config.get("keyFile") else os.path.join(hh.state_dir, "secrets.json")
WS = hh.workspace
OUT_DIR = os.path.join(WS, "voice", "out")
LOG = os.path.join(WS, "voice", "usage.jsonl")
VOICES = hh.config.get("voices", {})  # the role's voices: name -> Fish voice id (the role's data, in its instance config)
DEFAULT_VOICE = VOICES.get(hh.config.get("defaultVoice", ""), hh.config.get("defaultVoice", ""))
MODEL = hh.config.get("voiceModel", "drama-3")  # drama-3 用成对标签 [emphasis]…[/emphasis] [laugh]…[/laugh] [whisper]…[/whisper] [sigh]…[/sigh]，指示要淡
FFMPEG = "/opt/homebrew/bin/ffmpeg"


def key():
    return json.load(open(SECRETS))[hh.config.get("keyField") or "fishAudioKey"]


def pace(text):
    """我打字不爱加标点，TTS 就会一口气念完。这里补上停顿：
    行内空格 → 逗号；每行结尾补句号；行与行之间加 [break]。已有的 [情绪] 标记保留。"""
    lines = [l.strip() for l in re.split(r"[\n]+", text) if l.strip()]
    out = []
    for l in lines:
        l = re.sub(r"(?<=[^\s\[\]，。！？、,.!?~…])\s+(?=[^\s\[])", "，", l)
        if not re.search(r"[，。！？!?~…\]]$", l):
            l += "。"
        out.append(l)
    return " [break] ".join(out)


def tts(text, voice, fmt="mp3", model=None):
    model = model or MODEL
    body = json.dumps({"text": text, "format": fmt, "reference_id": voice, "normalize": True}).encode()
    req = urllib.request.Request(
        "https://api.fish.audio/v1/tts", data=body, method="POST",
        headers={"Authorization": f"Bearer {key()}", "Content-Type": "application/json", "model": model},
    )
    for att in range(4):  # Fish 偶尔 401/空回包，重试几次
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                b = r.read()
            if b:
                return b
        except urllib.error.HTTPError as e:
            if att == 3:
                sys.exit(f"fish error {e.code}: {e.read()[:300].decode(errors='replace')}")
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as e:  # 断网、DNS、超时也重试
            if att == 3:
                sys.exit(say("fishUnreachable", reason=getattr(e, 'reason', e)))
        time.sleep(3 * (att + 1))
    sys.exit("fish error: empty audio")


def resolve_voice(voice):
    """音色名或 32 位十六进制的 Fish 音色 id；别的（打错的名字）直接拒绝，不浪费一次请求。"""
    if voice in VOICES:
        return VOICES[voice]
    if re.fullmatch(r"[0-9a-f]{32}", voice or ""):
        return voice
    # 只记得前几位（笔记里常写 0f08cacd 这种）：在已知音色和用过的记录里找唯一一个对得上的
    if re.fullmatch(r"[0-9a-f]{6,31}", voice or ""):
        known = set(v for v in VOICES.values() if len(v) == 32)
        try:
            for line in open(LOG, encoding="utf-8"):
                for m in re.findall(r"[0-9a-f]{32}", line):
                    known.add(m)
        except OSError:
            pass
        hits = sorted(k for k in known if k.startswith(voice))
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            sys.exit(say("voicePrefixMany", voice=voice, list=', '.join(hits)))
    sys.exit(say("voiceUnknown", voice=voice, list=' / '.join(VOICES)))



# Fish S2 官方标签（docs.fish.audio/api-reference/emotion-reference，2026-10-31 抄）。
# 不在表里的英文单词标签模型只能瞎猜，祥子 v13 的「额」就出在 [giggle] [sigh] 上（2026-10-31）。
FISH_TAGS = set("""happy sad angry excited calm nervous confident surprised satisfied delighted scared worried upset
frustrated depressed empathetic embarrassed disgusted moved proud relaxed grateful curious sarcastic disdainful unhappy
anxious hysterical indifferent uncertain doubtful confused disappointed regretful guilty ashamed jealous envious hopeful
optimistic pessimistic nostalgic lonely bored contemptuous sympathetic compassionate determined resigned shouting
screaming whispering emphasis laughing chuckling sobbing sighing groaning panting gasping yawning snoring break
long-break""".split()) | {"in a hurry tone", "soft tone", "crying loudly", "clear throat", "audience laughing",
                          "background laughter", "crowd laughing", "sincere", "serious"}
# sincere/serious 不在官方表里，但 10-30、10-31 实测干净，放行。
SOUND_TAGS = {"laughing": "哈", "chuckling": "嘿", "sighing": "唉", "sobbing": "呜"}


def lint_tags(text):
    """生成前查标签，有问题打警告（不拦）。规矩：情绪标签只放句首；声音标签后面要跟对应的字。"""
    warns = []
    for line in text.splitlines():
        for m in re.finditer(r"\[([^\]]+)\]", line):
            tag = m.group(1).strip().lower()
            if "," in tag or len(tag.split()) > 3:
                continue  # 自然语言描述，S2 允许
            if tag not in FISH_TAGS:
                warns.append(say("tagUnknown", tag=tag))
            if tag in SOUND_TAGS:
                after = line[m.end():].lstrip(" ，,")
                if not after.startswith(SOUND_TAGS[tag]):
                    warns.append(say("tagNoSound", tag=tag, sound_tags=SOUND_TAGS[tag]))
    for w in warns:
        print(say("tagWarning", w=w), file=sys.stderr)
    return warns

def speak(text, voice, raw=False, model=None):
    model = model or MODEL
    voice = resolve_voice(voice)
    if not model.startswith("drama"):
        lint_tags(text)  # S2 的标签表；drama-3 用成对标签和自然语言，不查
    if not raw:
        text = pace(text)
    os.makedirs(OUT_DIR, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    h = hashlib.md5(text.encode()).hexdigest()[:6]
    mp3 = os.path.join(OUT_DIR, f"{stamp}-{h}.mp3")
    ogg = mp3[:-4] + ".ogg"
    open(mp3, "wb").write(tts(text, voice, model=model))
    # WhatsApp/QQ 语音条要 ogg/opus 单声道
    subprocess.run([FFMPEG, "-loglevel", "error", "-y", "-i", mp3, "-ac", "1", "-ar", "48000",
                    "-c:a", "libopus", "-b:a", "32k", "-application", "voip", ogg], check=True)
    os.remove(mp3)
    with open(LOG, "a") as f:
        f.write(json.dumps({"t": stamp, "chars": len(text), "voice": voice, "model": model}, ensure_ascii=False) + "\n")
    cutoff = datetime.datetime.now().timestamp() - 7 * 86400
    for n in os.listdir(OUT_DIR):
        p = os.path.join(OUT_DIR, n)
        if os.path.getmtime(p) < cutoff:
            os.remove(p)
    print(ogg)


def usage():
    month = datetime.datetime.now().strftime("%Y%m")
    n = c = 0
    if os.path.exists(LOG):
        for line in open(LOG):
            d = json.loads(line)
            if d["t"].startswith(month):
                n += 1; c += d["chars"]
    print(json.dumps({"month": month, "clips": n, "chars": c, "model": MODEL}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("say"); s.add_argument("text"); s.add_argument("--voice", default=DEFAULT_VOICE, help=say("helpVoice"))
    s.add_argument("--raw", action="store_true", help=say("helpRaw"))
    s.add_argument("--model", default=None, help=say("helpModel"))
    sub.add_parser("usage")
    a = ap.parse_args()
    if a.cmd == "say":
        # 在 LANG 不是 UTF-8 的 shell 里，中文参数会被解成 surrogate，Fish 那边编码就炸（11-12 荆轲 v8）
        a.text = a.text.encode("utf-8", "surrogateescape").decode("utf-8", "replace")
    speak(a.text, a.voice, a.raw, a.model) if a.cmd == "say" else usage()
