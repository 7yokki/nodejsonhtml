/*! NOH — Node.js On HTML | gerçek Node.js, tarayıcıda (v86) | MIT */
(function () {
"use strict";

/* ---- çekirdek ---- */
/**
 * Node.js On HTML (NOH)
 * ---------------------
 * Tarayıcıda, GERÇEK bir Linux çekirdeği (v86 ile x86 emülasyonu) içinde
 * GERÇEK Node.js çalıştıran mini container.
 *
 * Statik site + her şey kullanıcının bilgisayarında + kütüphane Node.js için
 * yazılmış  =>  NOH.
 *
 * Tasarım ilkeleri (tahmin edilebilirlik):
 *  1. Her exec() çağrısı ayrı bir süreç: stdout, stderr ve çıkış kodu AYRI döner.
 *  2. Çıktı sınırlandırılmıştır (sentinel protokolü), gönderim/okuma FIFO sıralıdır.
 *  3. Dosya alışverişi 9p üzerinden (writeFile/readFile), shell kaçış hatası yok.
 *  4. Aynı imaj + aynı girdi => aynı çıktı. Saat ve ağ opsiyonel, varsayılan kapalı.
 *
 * Gereksinim: v86 (libv86.js + v86.wasm + seabios/vgabios) ve NOH imajı
 * (tools/build-image.sh ile üretilir). Bkz. README.md
 */

const DEFAULTS = {
  memoryMB: 512,
  vgaMemoryMB: 2,
  bootTimeoutMs: 180_000,
  execTimeoutMs: 120_000,
  nodeBin: "node",
  workdir: "/work",
  // 9p'nin gest içindeki bağlama noktası:
  mountPoint: "/mnt/host",
};

/** Kabuk için tek tırnaklı güvenli kaçış. */
function shq(s) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

/** Sentinel için rastgele ama okunabilir belirteç. */
function token() {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return a[0].toString(36) + a[1].toString(36);
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError("NOH: veri string, Uint8Array veya ArrayBuffer olmalı");
}

class NOHError extends Error {
  constructor(msg, extra = {}) {
    super(msg);
    this.name = "NOHError";
    Object.assign(this, extra);
  }
}

/**
 * Basit FIFO kilidi: aynı anda tek exec, sıra garanti.
 * Tek seri hat üzerinde çalıştığımız için eşzamanlı exec karışıklık yaratırdı.
 */
class Mutex {
  constructor() { this._p = Promise.resolve(); }
  run(fn) {
    const next = this._p.then(fn, fn);
    this._p = next.catch(() => {});
    return next;
  }
}

class NOH {
  /**
   * @param {object} opts
   * @param {Function} opts.V86            v86 yapıcısı (window.V86 veya import { V86 } from "v86")
   * @param {object}  opts.assets          { wasm, seabios, vgabios, bzimage?, initrd?, hda?, initialState? }
   * @param {string}  [opts.cmdline]       çekirdek komut satırı
   * @param {number}  [opts.memoryMB]
   * @param {Function} [opts.onLog]        (satır) => void  — tanı amaçlı
   * @param {Function} [opts.onProgress]   ({phase, ratio}) => void
   */
  constructor(opts) {
    if (!opts || typeof opts.V86 !== "function") {
      throw new NOHError("NOH: opts.V86 (v86 yapıcısı) gerekli");
    }
    if (!opts.assets || !opts.assets.wasm) {
      throw new NOHError("NOH: opts.assets.wasm gerekli");
    }
    this.opts = { ...DEFAULTS, ...opts };
    this.emu = null;
    this.state = "idle"; // idle | booting | ready | closed
    this._buf = "";
    this._waiters = [];
    this._mutex = new Mutex();
    this._dec = new TextDecoder();
  }

  /* ------------------------------------------------------------------ *
   * BOOT
   * ------------------------------------------------------------------ */

  async boot() {
    if (this.state !== "idle") throw new NOHError(`NOH: boot() yalnızca 'idle' durumunda çağrılabilir (şu an: ${this.state})`);
    this.state = "booting";
    const { V86, assets, memoryMB, vgaMemoryMB } = this.opts;

    const cfg = {
      wasm_path: assets.wasm,
      memory_size: memoryMB * 1024 * 1024,
      vga_memory_size: vgaMemoryMB * 1024 * 1024,
      bios: { url: assets.seabios },
      vga_bios: { url: assets.vgabios },
      // 9p: boş bir dosya sistemi; NOH bunu dosya alışverişi için kullanır.
      filesystem: {},
      autostart: true,
      disable_keyboard: true,
      disable_mouse: true,
      disable_speaker: true,
      // Ağ varsayılan olarak KAPALI (tahmin edilebilirlik). networkRelay verilirse açılır.
      ...(this.opts.networkRelay ? { network_relay_url: this.opts.networkRelay } : {}),
    };

    if (assets.initialState) {
      // Hızlı yol: hazır snapshot (boot + node yüklü halde).
      cfg.initial_state = { url: assets.initialState };
    } else {
      // Yavaş yol: çekirdek + initrd (+ isteğe bağlı disk) ile soğuk açılış.
      if (!assets.bzimage) throw new NOHError("NOH: initialState ya da bzimage gerekli");
      cfg.bzimage = { url: assets.bzimage };
      if (assets.initrd) cfg.initrd = { url: assets.initrd };
      if (assets.hda) cfg.hda = { url: assets.hda, async: true };
      cfg.cmdline = this.opts.cmdline ||
        "rw console=ttyS0 rdinit=/init quiet loglevel=3 tsc=reliable mitigations=off random.trust_cpu=on";
    }

    this.emu = new V86(cfg);
    this.emu.add_listener("serial0-output-byte", (b) => this._onByte(b));

    this._progress("download", 0);
    this.emu.add_listener("download-progress", (e) => {
      if (e && e.total) this._progress("download", e.loaded / e.total);
    });

    // Snapshot ile açıldıysa shell zaten hazır; soğuk açılışta prompt'u bekle.
    await this._waitReady(assets.initialState ? 15_000 : this.opts.bootTimeoutMs);

    await this._raw(
      [
        "stty -echo -onlcr 2>/dev/null",
        "export PS1='' PS2='' PS3='' PS4=''",
        "export LANG=C.UTF-8 TERM=dumb",
        `mkdir -p ${shq(this.opts.workdir)} ${shq(this.opts.mountPoint)}`,
        // 9p bağla (zaten bağlıysa hata vermesin)
        `mountpoint -q ${shq(this.opts.mountPoint)} || mount -t 9p -o trans=virtio,version=9p2000.L host9p ${shq(this.opts.mountPoint)} 2>/dev/null`,
        `cd ${shq(this.opts.workdir)}`,
      ].join("\n"),
      15_000
    );

    this.state = "ready";
    this._progress("ready", 1);
    return this;
  }

  _progress(phase, ratio) {
    if (this.opts.onProgress) this.opts.onProgress({ phase, ratio });
  }

  _log(line) {
    if (this.opts.onLog) this.opts.onLog(line);
  }

  /* ------------------------------------------------------------------ *
   * SERİ HAT
   * ------------------------------------------------------------------ */

  _onByte(b) {
    // UTF-8 çok baytlı karakterleri bozmamak için baytları biriktirip çözeriz.
    this._bytes = this._bytes || [];
    this._bytes.push(b);
    // Satır sonu veya yeterince bayt birikince çöz:
    if (b === 10 || this._bytes.length >= 256) this._flushBytes();
    else if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => { this._flushTimer = null; this._flushBytes(); }, 4);
    }
  }

  _flushBytes() {
    if (!this._bytes || !this._bytes.length) return;
    // Yarım kalmış UTF-8 dizisini sonraki parçaya bırak.
    let end = this._bytes.length;
    let i = end - 1, need = 0;
    while (i >= 0 && end - i <= 4) {
      const c = this._bytes[i];
      if ((c & 0xc0) === 0x80) { i--; continue; }
      if (c >= 0xf0) need = 4; else if (c >= 0xe0) need = 3; else if (c >= 0xc0) need = 2; else need = 1;
      if (end - i < need) end = i;
      break;
    }
    const chunk = this._bytes.splice(0, end);
    this._buf += this._dec.decode(new Uint8Array(chunk), { stream: false });
    this._pump();
  }

  _pump() {
    for (let k = this._waiters.length - 1; k >= 0; k--) {
      const w = this._waiters[k];
      if (w.test()) {
        this._waiters.splice(k, 1);
        w.resolve();
      }
    }
  }

  _waitFor(testFn, timeoutMs, what) {
    return new Promise((resolve, reject) => {
      const w = { test: testFn, resolve };
      const t = setTimeout(() => {
        const i = this._waiters.indexOf(w);
        if (i >= 0) this._waiters.splice(i, 1);
        reject(new NOHError(`NOH: zaman aşımı (${what}, ${timeoutMs} ms)`, { code: "ETIMEDOUT" }));
      }, timeoutMs);
      w.resolve = () => { clearTimeout(t); resolve(); };
      this._waiters.push(w);
      if (testFn()) { this._waiters.splice(this._waiters.indexOf(w), 1); clearTimeout(t); resolve(); }
    });
  }

  _send(text) {
    this.emu.serial0_send(text);
  }

  async _waitReady(timeoutMs) {
    // Boot'un bittiğini anlamak için bir yankı sentinel'i gönder.
    const tok = token();
    const marker = `__NOH_READY_${tok}__`;
    let sent = false;
    const send = () => { if (!sent || !this._buf.includes(marker)) this._send(`\necho ${marker}\n`); };
    const iv = setInterval(send, 1500);
    send(); sent = true;
    try {
      await this._waitFor(() => this._buf.includes(marker), timeoutMs, "boot");
    } finally {
      clearInterval(iv);
    }
    this._buf = "";
  }

  /** Sentinelli, kendi kendine kapanan bir komut bloğu çalıştırır. */
  async _raw(script, timeoutMs) {
    const tok = token();
    const end = `__NOH_END_${tok}__`;
    this._buf = "";
    this._send(`${script}\necho ${end}\n`);
    await this._waitFor(() => this._buf.includes(end), timeoutMs, "kabuk");
    this._buf = "";
  }

  /* ------------------------------------------------------------------ *
   * ÇALIŞTIRMA
   * ------------------------------------------------------------------ */

  /**
   * Bir kabuk komutu çalıştırır. Kesin sonuç: { stdout, stderr, code }.
   * stdout/stderr ayrı dosyalara yönlendirilir ve base64 ile geri okunur;
   * böylece ikili çıktı ve ANSI/CR karışıklığı sonucu bozamaz.
   */
  async exec(command, { cwd, env, stdin, timeoutMs } = {}) {
    this._assertReady();
    const limit = timeoutMs ?? this.opts.execTimeoutMs;
    return this._mutex.run(() => this._exec(command, { cwd, env, stdin, limit }));
  }

  async _exec(command, { cwd, env, stdin, limit }) {
    const tok = token();
    const dir = `/tmp/.noh_${tok}`;
    const beg = `__NOH_BEG_${tok}__`;
    const end = `__NOH_END_${tok}__`;

    const envPart = env
      ? Object.entries(env).map(([k, v]) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new NOHError(`NOH: geçersiz ortam değişkeni adı: ${k}`);
          return `export ${k}=${shq(v)}`;
        }).join("; ") + "; "
      : "";

    // stdin varsa 9p yerine here-doc yerine base64 ile geçici dosyaya yaz.
    let stdinSetup = "";
    let stdinRedirect = "";
    if (stdin != null) {
      const b64 = b64encode(toBytes(stdin));
      stdinSetup = `mkdir -p ${dir}; printf %s ${shq(b64)} | base64 -d > ${dir}/in; `;
      stdinRedirect = ` < ${dir}/in`;
    } else {
      stdinRedirect = " < /dev/null";
    }

    const cwdPart = cwd ? `cd ${shq(cwd)} && ` : "";
    const script =
      `mkdir -p ${dir}; ${stdinSetup}` +
      `( ${envPart}${cwdPart}${command} )${stdinRedirect} > ${dir}/out 2> ${dir}/err; ` +
      `__c=$?; ` +
      `echo ${beg}; ` +
      `echo "CODE:$__c"; ` +
      `echo "OUT:$(base64 ${dir}/out | tr -d '\\n')"; ` +
      `echo "ERR:$(base64 ${dir}/err | tr -d '\\n')"; ` +
      `echo ${end}; rm -rf ${dir}`;

    this._buf = "";
    this._send(script + "\n");
    await this._waitFor(() => this._buf.includes(end), limit, `exec: ${command.slice(0, 60)}`);
    const raw = this._buf;
    this._buf = "";

    const s = raw.indexOf(beg);
    const e = raw.indexOf(end);
    const body = raw.slice(s + beg.length, e);
    const grab = (name) => {
      const m = body.match(new RegExp(`^${name}:(.*)$`, "m"));
      return m ? m[1].trim() : "";
    };
    const code = parseInt(grab("CODE"), 10);
    const dec = new TextDecoder();
    return {
      code: Number.isNaN(code) ? -1 : code,
      stdout: dec.decode(b64decode(grab("OUT"))),
      stderr: dec.decode(b64decode(grab("ERR"))),
    };
  }

  /** exec() gibi ama sıfırdan farklı çıkış kodunda hata fırlatır. */
  async run(command, opts) {
    const r = await this.exec(command, opts);
    if (r.code !== 0) {
      throw new NOHError(`NOH: komut ${r.code} koduyla çıktı: ${command}\n${r.stderr}`, r);
    }
    return r;
  }

  /* ------------------------------------------------------------------ *
   * NODE.JS
   * ------------------------------------------------------------------ */

  /** Node sürümünü döndürür (ör. "v22.16.0"). */
  async nodeVersion() {
    const r = await this.run(`${this.opts.nodeBin} --version`);
    return r.stdout.trim();
  }

  /**
   * JavaScript kodunu gerçek Node.js ile çalıştırır.
   * @param {string} code
   * @param {object} [o]  { args, env, stdin, cwd, timeoutMs, esm }
   */
  async runNode(code, o = {}) {
    const name = `/tmp/noh_${token()}.${o.esm ? "mjs" : "cjs"}`;
    await this.writeFile(name, code);
    const args = (o.args || []).map(shq).join(" ");
    try {
      return await this.exec(`${this.opts.nodeBin} ${shq(name)} ${args}`, o);
    } finally {
      // Temizliği BEKLE: destroy()/snapshot hemen ardından gelirse temp dosya sızmasın.
      // Temizlik hatası asıl sonucu gizlememeli.
      await this.exec(`rm -f ${shq(name)}`).catch(() => {});
    }
  }

  /** Bir Node betiğini (sanal FS'deki yoldan) çalıştırır. */
  async runNodeFile(path, o = {}) {
    const args = (o.args || []).map(shq).join(" ");
    return this.exec(`${this.opts.nodeBin} ${shq(path)} ${args}`, o);
  }

  /** npm install (ağ gerektirir; networkRelay ya da önceden yüklenmiş imaj). */
  async npm(args, o = {}) {
    return this.exec(`npm ${args}`, { timeoutMs: 600_000, ...o });
  }

  /* ------------------------------------------------------------------ *
   * DOSYA SİSTEMİ  (9p köprüsü)
   * ------------------------------------------------------------------ */

  /**
   * Konuk içinde `path` yoluna dosya yazar.
   * Yol, konukta mutlak olmalıdır. Arka planda 9p'ye yazıp konukta taşırız.
   */
  async writeFile(path, data) {
    this._assertReady();
    const bytes = toBytes(data);
    const id = `t_${token()}`;
    await this.emu.create_file(`/${id}`, bytes); // 9p kökü
    const from = `${this.opts.mountPoint}/${id}`;
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    await this.run(`mkdir -p ${shq(dir)} && mv ${shq(from)} ${shq(path)}`);
  }

  /** Konuktaki bir dosyayı Uint8Array olarak okur. */
  async readFile(path) {
    this._assertReady();
    const id = `t_${token()}`;
    const to = `${this.opts.mountPoint}/${id}`;
    await this.run(`cp ${shq(path)} ${shq(to)}`);
    const data = await this.emu.read_file(`/${id}`);
    this.exec(`rm -f ${shq(to)}`).catch(() => {});
    return data;
  }

  async readTextFile(path) {
    return new TextDecoder().decode(await this.readFile(path));
  }

  async mkdir(path) { await this.run(`mkdir -p ${shq(path)}`); }
  async rm(path, { recursive = false } = {}) { await this.run(`rm ${recursive ? "-rf" : "-f"} ${shq(path)}`); }
  async ls(path = ".") {
    const r = await this.run(`ls -1A ${shq(path)}`);
    return r.stdout.split("\n").filter(Boolean);
  }
  async exists(path) { return (await this.exec(`test -e ${shq(path)}`)).code === 0; }

  /** { "yol": "içerik", ... } şeklinde birden çok dosya yazar. */
  async writeFiles(map, baseDir = "") {
    for (const [p, content] of Object.entries(map)) {
      await this.writeFile(baseDir ? `${baseDir.replace(/\/$/, "")}/${p}` : p, content);
    }
  }

  /* ------------------------------------------------------------------ *
   * ANLIK GÖRÜNTÜ (SNAPSHOT)
   * ------------------------------------------------------------------ */

  /**
   * Çalışan container'ın tam durumunu ArrayBuffer olarak döndürür.
   * Bir kez boot + `npm ci` yapıp bunu barındırırsanız sonraki açılışlar saniyeler sürer.
   */
  async saveSnapshot() {
    this._assertReady();
    return this._mutex.run(() => this.emu.save_state());
  }

  /* ------------------------------------------------------------------ *
   * KAPAT
   * ------------------------------------------------------------------ */

  async destroy() {
    if (this.state === "closed") return;
    this.state = "closed";
    try { this.emu && this.emu.destroy(); } catch (_) { /* yoksay */ }
    this._waiters.forEach((w) => w.resolve());
    this._waiters = [];
  }

  _assertReady() {
    if (this.state !== "ready") {
      throw new NOHError(`NOH: container hazır değil (durum: ${this.state}). Önce await noh.boot()`);
    }
  }
}

/* -------------------------------------------------------------------- *
 * base64 yardımcıları (btoa/atob bayt güvenli değil; elle yapıyoruz)
 * -------------------------------------------------------------------- */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64REV = (() => { const m = new Int16Array(256).fill(-1); for (let i = 0; i < 64; i++) m[B64.charCodeAt(i)] = i; return m; })();

function b64encode(bytes) {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==";
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
  }
  return out;
}

function b64decode(str) {
  str = str.replace(/[^A-Za-z0-9+/]/g, "");
  const len = str.length;
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const a = B64REV[str.charCodeAt(i)];
    const b = B64REV[str.charCodeAt(i + 1)];
    const c = i + 2 < len ? B64REV[str.charCodeAt(i + 2)] : -1;
    const d = i + 3 < len ? B64REV[str.charCodeAt(i + 3)] : -1;
    out[o++] = (a << 2) | (b >> 4);
    if (c >= 0) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (d >= 0) out[o++] = ((c & 3) << 6) | d;
  }
  return out.subarray(0, o);
}



/* ---- tarayıcı katmanı ---- */
/**
 * NOH tarayıcı katmanı
 * --------------------
 * Geliştirici deneyimi:
 *
 *   <script src="https://sitemiz.com/cdn/noh.js"></script>
 *   <script type="text/node" src="https://.../mylib.js" data-name="mylib"></script>
 *   <script type="text/node">
 *     const lib = require("mylib");
 *     console.log(lib.hello());
 *   </script>
 *
 * Tarayıcı `type="text/node"` bloklarını ÇALIŞTIRMAZ; NOH okur, container'daki
 * gerçek Node.js'e verir. Çıktı: console + [data-noh-output] + NOH.on(...).
 *
 * Bu dosya çekirdek sınıfı (noh.js) içe aktarır; yayın için
 * tools/bundle.mjs ikisini tek klasik <script> dosyasına birleştirir.
 */
const Core = NOH;
const NODE_TYPE = "text/node";
const LIB_DIR = "/work/node_modules";

/* -------------------------------------------------------------------- *
 * Konum: noh.js'in yanındaki dosyaları (v86 vb.) bulmak için
 * -------------------------------------------------------------------- */

function detectBase() {
  // Klasik <script> içinde currentScript; modülde import.meta.url.
  let src = "";
  try { src = (document.currentScript && document.currentScript.src) || ""; } catch (_) {}
  if (!src) {
    
  }
  if (!src) {
    // Son çare: sayfadaki noh*.js etiketini bul
    const s = Array.from(document.scripts).find((x) => /noh[^/]*\.js(\?|$)/.test(x.src));
    src = s ? s.src : "";
  }
  return src ? src.replace(/[^/]*(\?.*)?$/, "") : "./";
}

const BASE = detectBase();

/* -------------------------------------------------------------------- *
 * Küçük olay yayıcı
 * -------------------------------------------------------------------- */

class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] ||= []).push(fn); return () => this.off(ev, fn); }
  off(ev, fn) { this._h[ev] = (this._h[ev] || []).filter((f) => f !== fn); }
  emit(ev, data) {
    for (const f of this._h[ev] || []) {
      try { f(data); } catch (e) { console.error("[NOH] dinleyici hatası:", e); }
    }
  }
}

/* -------------------------------------------------------------------- *
 * Yardımcılar
 * -------------------------------------------------------------------- */

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new NOHError(`NOH: betik yüklenemedi: ${url}`));
    document.head.appendChild(s);
  });
}

/** "https://x/y/my-lib.min.js?v=2" -> "my-lib" */
function guessLibName(url) {
  const file = String(url).split("?")[0].split("#")[0].split("/").pop() || "lib";
  return file.replace(/\.(min\.)?(c|m)?js$/i, "") || "lib";
}

/** Paket adı güvenli mi? (klasör adı olarak kullanılacak) */
function validName(name) {
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name);
}

const isNodeScript = (el) =>
  el.tagName === "SCRIPT" && (el.getAttribute("type") || "").toLowerCase() === NODE_TYPE;

/* -------------------------------------------------------------------- *
 * NOHBrowser: window.NOH
 * -------------------------------------------------------------------- */

class NOHBrowser extends Emitter {
  constructor() {
    super();
    this.core = null;
    this.options = {
      base: BASE,
      memoryMB: 512,
      auto: true,          // sayfa yüklenince otomatik başlat
      outputSelector: "[data-noh-output]",
      consoleOutput: true,
      // v86 dosyaları noh.js'in yanında:
      v86: "libv86.js",
      wasm: "v86.wasm",
      seabios: "seabios.bin",
      vgabios: "vgabios.bin",
      state: "noh-state.bin",
      bzimage: "noh-vmlinuz",
      initrd: "noh-initramfs.gz",
    };
    this.libs = new Map();   // ad -> { url, path }
    this._booted = null;     // boot() Promise'i
    this._chain = Promise.resolve();   // kayıtlı işleri sıralı çalıştırır
    this._seen = new WeakSet();
    this.ready = new Promise((res, rej) => { this._resolveReady = res; this._rejectReady = rej; });
    this.ready.catch(() => {}); // yakalanmamış reddi önle; kullanıcı yine de .catch edebilir
  }

  /** Ayarları değiştir. boot() başlamadan önce çağrılmalı. */
  config(opts = {}) {
    if (this._booted) throw new NOHError("NOH: config() boot başladıktan sonra çağrılamaz");
    Object.assign(this.options, opts);
    return this;
  }

  _url(name) {
    const v = this.options[name];
    return /^([a-z]+:)?\/\//i.test(v) || v.startsWith("/") ? v : this.options.base + v;
  }

  /* ------------------------------ boot ------------------------------ */

  boot() {
    if (this._booted) return this._booted;
    this._booted = (async () => {
      if (!window.V86) await loadScript(this._url("v86"));
      if (typeof window.V86 !== "function") {
        // Bazı derlemeler V86Starter dışa açar
        window.V86 = window.V86 || window.V86Starter;
      }
      if (typeof window.V86 !== "function") throw new NOHError("NOH: libv86.js yüklendi ama V86 bulunamadı");

      const hasState = await fetch(this._url("state"), { method: "HEAD" }).then((r) => r.ok).catch(() => false);
      const assets = {
        wasm: this._url("wasm"),
        seabios: this._url("seabios"),
        vgabios: this._url("vgabios"),
        ...(hasState
          ? { initialState: this._url("state") }
          : { bzimage: this._url("bzimage"), initrd: this._url("initrd") }),
      };
      this.core = new Core({
        V86: window.V86,
        assets,
        memoryMB: this.options.memoryMB,
        onProgress: (p) => this.emit("progress", p),
      });
      await this.core.boot();
      this.emit("ready", { node: await this.core.nodeVersion().catch(() => "") });
      this._resolveReady(this);
      return this;
    })();
    this._booted.catch((e) => { this._rejectReady(e); this.emit("error", e); });
    return this._booted;
  }

  /* --------------------------- çıktı yönlendirme --------------------------- */

  _print(kind, text, label) {
    if (!text) return;
    this.emit(kind, { text, label });
    if (this.options.consoleOutput) {
      (kind === "stderr" ? console.error : console.log)(text.replace(/\n$/, ""));
    }
    for (const el of document.querySelectorAll(this.options.outputSelector)) {
      const span = document.createElement("span");
      span.className = "noh-" + kind;
      span.textContent = text;
      el.appendChild(span);
    }
  }

  /* ---------------------------- kütüphaneler ---------------------------- */

  /**
   * Bir Node kütüphanesini container'a yükler ve `require(name)` ile erişilir yapar.
   * @param {string|{name?:string,url?:string,code?:string,main?:string}} src
   */
  async addLibrary(src) {
    const spec = typeof src === "string" ? { url: src } : { ...src };
    if (!spec.url && spec.code == null) throw new NOHError("NOH: addLibrary için url veya code gerekli");
    // Açıkça verilen ad (boş string dahil) türetilmez; geçersizse reddedilir.
    const name = spec.name !== undefined && spec.name !== null ? String(spec.name) : guessLibName(spec.url || "lib");
    if (!validName(name)) throw new NOHError(`NOH: geçersiz kütüphane adı: ${JSON.stringify(name)}`);

    let code = spec.code;
    if (code == null) {
      const resp = await fetch(spec.url);
      if (!resp.ok) throw new NOHError(`NOH: kütüphane indirilemedi (${resp.status}): ${spec.url}`);
      code = new Uint8Array(await resp.arrayBuffer());
    }

    await this.boot();
    const dir = `${LIB_DIR}/${name}`;
    const main = spec.main || "index.js";
    await this.core.writeFile(`${dir}/${main}`, code);
    // require("ad") çözümlensin: package.json main alanı
    await this.core.writeFile(`${dir}/package.json`, JSON.stringify({ name, version: "0.0.0", main }));
    this.libs.set(name, { url: spec.url || null, path: dir });
    this.emit("library", { name, path: dir });
    return name;
  }

  /* ------------------------------ çalıştırma ------------------------------ */

  /**
   * Node kodu çalıştırır. Çıktı, olaylar ve [data-noh-output]'a da gider.
   * Döner: { code, stdout, stderr }
   */
  async run(code, opts = {}) {
    await this.boot();
    const label = opts.label || "kod";
    const r = await this.core.runNode(code, {
      esm: !!opts.esm,
      args: opts.args,
      env: { NODE_PATH: LIB_DIR, ...(opts.env || {}) },
      cwd: opts.cwd,
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs,
    });
    this._print("stdout", r.stdout, label);
    this._print("stderr", r.stderr, label);
    this.emit("exit", { code: r.code, label });
    return r;
  }

  /** Kabuk komutu çalıştırır (NODE_PATH ayarlı). */
  async exec(cmd, opts = {}) {
    await this.boot();
    return this.core.exec(cmd, { ...opts, env: { NODE_PATH: LIB_DIR, ...(opts.env || {}) } });
  }

  /** Alt katmana (NOH sınıfı) doğrudan erişim: writeFile, readFile, npm, snapshot ... */
  async container() { await this.boot(); return this.core; }

  /* ---------------------- <script type="text/node"> tarayıcı ---------------------- */

  /** Sayfadaki (ve sonradan eklenen) text/node etiketlerini sırayla işler. */
  scan(root = document) {
    for (const el of root.querySelectorAll(`script[type="${NODE_TYPE}"]`)) this._enqueue(el);
  }

  _enqueue(el) {
    if (this._seen.has(el)) return;
    this._seen.add(el);
    // Zincir: bir iş hata verirse sonrakiler yine de denenir, ama hata bildirilir.
    this._chain = this._chain.then(() => this._process(el)).catch((e) => this._fail(e, el));
  }

  async _process(el) {
    const src = el.getAttribute("src");
    if (src) {
      const url = new URL(src, document.baseURI).href;
      const name = el.getAttribute("data-name") || guessLibName(url);
      await this.addLibrary({ url, name, main: el.getAttribute("data-main") || undefined });
      return;
    }
    const code = el.textContent;
    if (!code.trim()) return;
    const esm = (el.getAttribute("data-module") != null) || el.hasAttribute("module");
    const label = el.getAttribute("data-label") || "blok";
    await this.run(code, { esm, label });
  }

  _fail(e, el) {
    const msg = e && e.message ? e.message : String(e);
    console.error("[NOH]", msg, el);
    this._print("stderr", "NOH hatası: " + msg + "\n", "hata");
    this.emit("error", e);
  }

  /** Sayfayı izle: sonradan eklenen text/node etiketlerini de işle. */
  observe() {
    if (this._mo || typeof MutationObserver === "undefined") return;
    this._mo = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (isNodeScript(n)) this._enqueue(n);
        else if (n.querySelectorAll) this.scan(n);
      }
    });
    this._mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  /** Bütün kuyruk bitene kadar bekler. */
  async idle() {
    let last;
    do { last = this._chain; await last; } while (last !== this._chain);
  }

  /** Önce kuyruktaki işleri bitirir (yarım kalmış çalıştırma/temizlik bırakmaz), sonra kapatır. */
  async destroy({ force = false } = {}) {
    if (!force) { try { await this.idle(); } catch (_) { /* hata zaten bildirildi */ } }
    if (this._mo) { this._mo.disconnect(); this._mo = null; }
    if (this.core) await this.core.destroy();
  }
}

/* -------------------------------------------------------------------- *
 * Otomatik başlatma
 * -------------------------------------------------------------------- */

function install(target = window) {
  if (target.NOH && target.NOH.__isNOHBrowser) return target.NOH;
  const noh = new NOHBrowser();
  Object.defineProperty(noh, "__isNOHBrowser", { value: true });
  // Çekirdek sınıf, ileri düzey kullanım için: new NOH.Core({...})
  noh.Core = Core;
  noh.Error = NOHError;
  noh.shq = shq;
  target.NOH = noh;

  const start = () => {
    // data-noh-* ayarları noh.js etiketinden oku
    const me = Array.from(document.scripts).find((s) => /noh[^/]*\.js(\?|$)/.test(s.src));
    if (me) {
      const map = { "data-memory": "memoryMB", "data-base": "base" };
      for (const [attr, key] of Object.entries(map)) {
        if (me.hasAttribute(attr)) noh.options[key] = key === "memoryMB" ? Number(me.getAttribute(attr)) : me.getAttribute(attr);
      }
      if (me.hasAttribute("data-manual")) noh.options.auto = false;
    }
    if (!noh.options.auto) return;
    noh.scan();
    noh.observe();
    if (document.querySelector(`script[type="${NODE_TYPE}"]`)) {
      noh.boot().catch(() => {});
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
  return noh;
}




install(window);
})();
