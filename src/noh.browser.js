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
import { NOH as Core, NOHError, shq } from "./noh.js";

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
    try { src = import.meta.url; } catch (_) {}
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
export function guessLibName(url) {
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

export function install(target = window) {
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

export { NOHBrowser, Core as NOHCore, NOHError, shq };
export default install;
