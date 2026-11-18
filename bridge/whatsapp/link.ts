// Linking a new device: the first WhatsApp login of a role, by pairing code (hh channels link whatsapp --phone <number>).
// It writes the login directory the bridge then uses. Only one process may hold a login, so the caller makes sure the
// bridge is not running. The phone number and the code go to the person at the terminal and nowhere else: nothing is logged.
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface LinkUpdate { connection?: string; qr?: string; code?: number }
export interface LinkSocket { on(update: (u: LinkUpdate) => void): void; requestPairingCode(phone: string): Promise<string>; end(): void }
/** Open one WhatsApp connection on a login directory */
export type Connect = (auth: string) => Promise<LinkSocket>;

/** WhatsApp closes the connection with this once the phone accepted the code: connect again, now logged in */
const RESTART = 515;

/** The real connection: baileys, from this directory's own packages (loaded only here, so the flow below runs without them) */
const baileys: Connect = async (auth) => {
  const lib = "baileys";
  const { default: makeWASocket, Browsers, makeCacheableSignalKeyStore, useMultiFileAuthState } = await import(lib);
  const quiet = { level: "silent", child() { return quiet; }, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
  const { state, saveCreds } = await useMultiFileAuthState(auth);
  const s = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, quiet) }, logger: quiet,
    browser: Browsers.macOS("Desktop"), markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false,
  });
  s.ev.on("creds.update", saveCreds);
  return {
    on: (update) => s.ev.on("connection.update", (u: { connection?: string; qr?: string; lastDisconnect?: { error?: { output?: { statusCode?: number } } } }) => {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      update({ ...(u.connection ? { connection: u.connection } : {}), ...(u.qr ? { qr: u.qr } : {}), ...(code === undefined ? {} : { code }) });
    }),
    requestPairingCode: (phone) => s.requestPairingCode(phone),
    end: () => { void Promise.resolve(s.end(undefined)).catch(() => {}); },
  };
};

/**
 * Link this role as a new device of the WhatsApp account with that phone number. say gets the pairing code, once; the
 * promise settles when the phone has accepted it and the login is on disk (directory 0700, files 0600), or rejects when
 * WhatsApp gave up — then nothing is left behind. A directory that holds anything already is refused, never reused.
 */
export async function link(o: { auth: string; phone: string; say(code: string): void; connect?: Connect; settleMs?: number }): Promise<void> {
  const phone = o.phone.replace(/\D/g, "");
  if (phone.length < 6) throw new Error("--phone: the account's number with its country code, digits only or with +");
  if (existsSync(o.auth) && readdirSync(o.auth).length) throw new Error(`${o.auth} is not empty: there is a login there already (hh channels remove, or move it away)`);
  mkdirSync(o.auth, { recursive: true, mode: 0o700 });
  chmodSync(o.auth, 0o700);
  const connect = o.connect ?? baileys;
  const old = process.umask(0o077);
  try {
    await new Promise<void>((resolve, reject) => {
      let asked = false;
      const go = async (): Promise<void> => {
        const s = await connect(o.auth);
        s.on((u) => {
          if (u.qr && !asked) { asked = true; s.requestPairingCode(phone).then(o.say, reject); }
          // a moment for the keys that arrive right after the login to reach the disk
          if (u.connection === "open") setTimeout(() => { s.end(); resolve(); }, o.settleMs ?? 5_000);
          if (u.connection !== "close") return;
          if (u.code === RESTART) go().catch(reject);
          else reject(new Error(`WhatsApp closed the connection before the device was linked (code ${u.code ?? "none"}): run it again for a new code`));
        });
      };
      go().catch(reject);
    });
  } catch (e) {
    rmSync(o.auth, { recursive: true, force: true });
    throw e;
  } finally {
    process.umask(old);
  }
  for (const f of readdirSync(o.auth)) chmodSync(join(o.auth, f), 0o600);
}
