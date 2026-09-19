/**
 * NOH tarayıcı katmanı testleri.
 * Gerçek dist/noh.js paketini (klasik betik olarak) çalıştırır; DOM ve V86 sahtedir.
 * V86'nın seri hattı gerçek bir /bin/sh sürecidir, "node" olarak bu Node.js kullanılır.
 * Doğrulananlar: <script type="text/node"> sıralaması, kütüphane yükleme + require,
 * data-name, çıktı yönlendirme, hata yönetimi, olaylar, config, güvenlik.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// paketi üret
const BUNDLE = join(tmpdir(), "noh-bundle-test.js");
execFileSync(process.execPath, [join(import.meta.dirname, "../tools/bundle.mjs"), BUNDLE], { stdio: "ignore" });
const bundleSrc = readFileSync(BUNDLE, "utf8");

const ROOT = mkdtempSync(join(tmpdir(), "noh-web-"));
const P9 = join(ROOT, "9p"), MNT = join(ROOT, "mnt"), WORK = join(ROOT, "work");
mkdirSync(P9); mkdirSync(WORK); symlinkSync(P9, MNT);
// Konuktaki /work/node_modules yolu bu testte gerçek bir dizine eşlenir:
const NM = join(WORK, "node_modules");

/* ---------------- sahte V86 (gerçek /bin/sh seri hattı) ---------------- */
class FakeV86 {
  constructor(cfg) {
    FakeV86.last = cfg;
    this.l = {};
    this.sh = spawn("/bin/sh", [], { stdio: ["pipe", "pipe", "pipe"] });
    const emit = (d) => { for (const b of d) (this.l["serial0-output-byte"] || []).forEach((f) => f(b)); };
    this.sh.stdout.on("data", emit); this.sh.stderr.on("data", emit);
  }
  add_listener(e, f) { (this.l[e] ||= []).push(f); }
  serial0_send(s) { this.sh.stdin.write(s); }
  async create_file(p, b) { writeFileSync(join(P9, p), b); }
  async read_file(p) { return new Uint8Array(readFileSync(join(P9, p))); }
  async save_state() { return new ArrayBuffer(8); }
  destroy() { this.sh.kill("SIGKILL"); }
}

/* ---------------- sahte DOM ---------------- */
function makeDOM({ scripts = [], nohSrc = "https://sitemiz.com/cdn/noh.js", nohAttrs = {} } = {}) {
  const mk = (o) => ({
    tagName: "SCRIPT", nodeType: 1,
    _a: { ...(o.attrs || {}) },
    src: o.src || "", textContent: o.text || "",
    getAttribute(n) { return n === "src" ? (o.src ? o.rawSrc || o.src : null) : (this._a[n] ?? null); },
    hasAttribute(n) { return n in this._a; },
  });
  const nodeScripts = scripts.map((s) => {
    const el = mk(s);
    if (s.src) { el._a.src = s.src; el.getAttribute = (n) => (n === "src" ? s.src : (el._a[n] ?? null)); }
    el._a.type = "text/node";
    return el;
  });
  const nohEl = { tagName: "SCRIPT", src: nohSrc, getAttribute: () => null, hasAttribute: (n) => n in nohAttrs, _a: nohAttrs };
  nohEl.getAttribute = (n) => nohAttrs[n] ?? null;
  const outputs = [];
  const outEl = { children: [], appendChild(c) { this.children.push(c); } };
  outputs.push(outEl);
  const doc = {
    readyState: "complete",
    baseURI: "https://demo.example/page.html",
    currentScript: nohEl,
    scripts: [nohEl, ...nodeScripts],
    head: { appendChild(s) { s.onload && setTimeout(s.onload, 0); } },
    documentElement: {},
    createElement: () => ({}),
    querySelector: (sel) => (sel.includes("text/node") && nodeScripts.length ? nodeScripts[0] : null),
    querySelectorAll: (sel) => (sel.includes("text/node") ? nodeScripts : sel.includes("data-noh-output") ? outputs : []),
    addEventListener() {},
  };
  doc.createElement = (t) => ({ tagName: t.toUpperCase(), className: "", textContent: "" });
  return { doc, outEl, nodeScripts };
}

/** Paketi yükle, sahte pencereyle çalıştır. */
function load(domOpts, { withState = true, fetchMap = {} } = {}) {
  const { doc, outEl, nodeScripts } = makeDOM(domOpts);
  const logs = [], errs = [];
  const fetches = [];
  const win = {
    V86: FakeV86,
    document: doc,
    console: { log: (...a) => logs.push(a.join(" ")), error: (...a) => errs.push(a.join(" ")), warn() {} },
    URL, Promise, Uint8Array, TextEncoder, TextDecoder, crypto: globalThis.crypto,
    setTimeout, clearTimeout, setInterval, clearInterval,
    MutationObserver: undefined,
    fetch: async (url, init = {}) => {
      fetches.push({ url, method: init.method || "GET" });
      if (init.method === "HEAD") return { ok: withState };
      if (url in fetchMap) {
        const body = fetchMap[url];
        if (body === 404) return { ok: false, status: 404 };
        const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
        return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
      }
      return { ok: false, status: 404 };
    },
  };
  win.window = win; win.globalThis = win;
  // Konuk yol eşlemesi: /work/node_modules -> gerçek dizin. NOH çekirdeği mountPoint/workdir'i
  // opts'tan alır; paket içi sabitleri test için yeniden yazıyoruz.
  const src = bundleSrc
    .replaceAll('const LIB_DIR = "/work/node_modules";', `const LIB_DIR = ${JSON.stringify(NM)};`)
    .replace('mountPoint: "/mnt/host"', `mountPoint: ${JSON.stringify(MNT)}`)
    .replace('workdir: "/work"', `workdir: ${JSON.stringify(WORK)}`)
    .replace('nodeBin: "node"', `nodeBin: ${JSON.stringify(process.execPath)}`);
  vm.createContext(win);
  vm.runInContext(src, win);
  return { win, doc, outEl, nodeScripts, logs, errs, fetches };
}

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "\n     ", (e.stack || e.message).split("\n").slice(0, 3).join("\n      ")); }
}

/* ===================================================================== */
console.log("\nyükleme");
await t("paket klasik betik olarak yüklenir, window.NOH tanımlanır", async () => {
  const { win } = load({});
  assert.ok(win.NOH && win.NOH.__isNOHBrowser);
  assert.equal(typeof win.NOH.run, "function");
  assert.equal(typeof win.NOH.addLibrary, "function");
  assert.equal(typeof win.NOH.Core, "function");
});
await t("paket ES modül sözdizimi içermez", async () => {
  assert.ok(!/^\s*(import|export)\s/m.test(bundleSrc.replace(/\/\*[\s\S]*?\*\//g, "")));
});
await t("text/node etiketi yoksa boot başlamaz (boşuna 300 MB indirilmez)", async () => {
  const { win } = load({ scripts: [] });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(win.NOH._booted, null);
});

console.log("\nasset yolları");
await t("v86 dosyaları noh.js'in yanından çözülür (sitemiz.com/cdn/)", async () => {
  const { win } = load({ scripts: [{ text: "console.log(1)" }] });
  await win.NOH.ready;
  const a = FakeV86.last;
  assert.equal(a.wasm_path, "https://sitemiz.com/cdn/v86.wasm");
  assert.equal(a.bios.url, "https://sitemiz.com/cdn/seabios.bin");
  assert.equal(a.vga_bios.url, "https://sitemiz.com/cdn/vgabios.bin");
  assert.equal(a.initial_state.url, "https://sitemiz.com/cdn/noh-state.bin");
  await win.NOH.destroy();
});
await t("snapshot yoksa soğuk boot varlıklarına düşer", async () => {
  const { win } = load({ scripts: [{ text: "console.log(1)" }] }, { withState: false });
  await win.NOH.ready;
  const a = FakeV86.last;
  assert.equal(a.bzimage.url, "https://sitemiz.com/cdn/noh-vmlinuz");
  assert.equal(a.initrd.url, "https://sitemiz.com/cdn/noh-initramfs.gz");
  assert.ok(!a.initial_state);
  await win.NOH.destroy();
});
await t("data-base ile farklı klasör", async () => {
  const { win } = load({ scripts: [{ text: "1" }], nohAttrs: { "data-base": "https://cdn2.example/x/" } });
  await win.NOH.ready;
  assert.equal(FakeV86.last.wasm_path, "https://cdn2.example/x/v86.wasm");
  await win.NOH.destroy();
});
await t("data-memory belleği ayarlar", async () => {
  const { win } = load({ scripts: [{ text: "1" }], nohAttrs: { "data-memory": "256" } });
  await win.NOH.ready;
  assert.equal(FakeV86.last.memory_size, 256 * 1024 * 1024);
  await win.NOH.destroy();
});

console.log("\n<script type=\"text/node\"> yürütme");
await t("satır içi kod çalışır: console + çıktı elemanı + olay", async () => {
  const { win, outEl, logs } = load({ scripts: [{ text: 'console.log("selam"); console.error("uyari");' }] });
  const ev = [];
  win.NOH.on("stdout", (e) => ev.push(["o", e.text])); win.NOH.on("stderr", (e) => ev.push(["e", e.text]));
  await win.NOH.ready; await win.NOH.idle();
  assert.ok(logs.includes("selam"));
  assert.deepEqual(ev, [["o", "selam\n"], ["e", "uyari\n"]]);
  assert.ok(outEl.children.some((c) => c.className === "noh-stdout" && c.textContent === "selam\n"));
  await win.NOH.destroy();
});
await t("çıkış kodu 'exit' olayıyla gelir", async () => {
  const { win } = load({ scripts: [{ text: "process.exit(5)" }] });
  const ex = []; win.NOH.on("exit", (e) => ex.push(e.code));
  await win.NOH.ready; await win.NOH.idle();
  assert.deepEqual(ex, [5]);
  await win.NOH.destroy();
});
await t("bloklar DOM sırasıyla çalışır", async () => {
  const { win, logs } = load({ scripts: [{ text: 'console.log("1")' }, { text: 'console.log("2")' }, { text: 'console.log("3")' }] });
  await win.NOH.ready; await win.NOH.idle();
  assert.deepEqual(logs, ["1", "2", "3"]);
  await win.NOH.destroy();
});

console.log("\nkütüphane import (asıl özellik)");
const LIB = 'module.exports = { hello: (n) => "merhaba " + n, ver: 42 };';
await t("src'li text/node kütüphanesi indirilir, sonraki blokta require() ile kullanılır", async () => {
  const url = "https://cdn.example/libs/mylib.js";
  const { win, logs } = load({
    scripts: [{ src: url }, { text: 'const l = require("mylib"); console.log(l.hello("dünya"), l.ver);' }],
  }, { fetchMap: { [url]: LIB } });
  await win.NOH.ready; await win.NOH.idle();
  assert.deepEqual(logs, ["merhaba dünya 42"]);
  await win.NOH.destroy();
});
await t("data-name ile ad verilir", async () => {
  const url = "https://cdn.example/libs/x.min.js";
  const { win, logs } = load({
    scripts: [{ src: url, attrs: { "data-name": "benim-lib" } }, { text: 'console.log(require("benim-lib").ver)' }],
  }, { fetchMap: { [url]: LIB } });
  await win.NOH.ready; await win.NOH.idle();
  assert.deepEqual(logs, ["42"]);
  await win.NOH.destroy();
});
await t("ad verilmezse dosya adından türetilir (lodash.min.js -> lodash)", async () => {
  const url = "https://cdn.example/lodash.min.js";
  const { win, logs } = load({
    scripts: [{ src: url }, { text: 'console.log(require("lodash").ver)' }],
  }, { fetchMap: { [url]: LIB } });
  await win.NOH.ready; await win.NOH.idle();
  assert.deepEqual(logs, ["42"]);
  await win.NOH.destroy();
});
await t("iki kütüphane birbirini require edebilir (NODE_PATH)", async () => {
  const a = "https://cdn.example/a.js", b = "https://cdn.example/b.js";
  const { win, logs } = load({
    scripts: [{ src: a }, { src: b }, { text: 'console.log(require("b").out)' }],
  }, { fetchMap: { [a]: 'module.exports = { v: "A" };', [b]: 'module.exports = { out: require("a").v + "B" };' } });
  await win.NOH.ready; await win.NOH.idle();
  assert.deepEqual(logs, ["AB"]);
  await win.NOH.destroy();
});
await t("Türkçe/UTF-8 içerikli kütüphane bozulmaz", async () => {
  const url = "https://cdn.example/tr.js";
  const { win, logs } = load({
    scripts: [{ src: url }, { text: 'console.log(require("tr").s)' }],
  }, { fetchMap: { [url]: 'module.exports = { s: "çğıöşü İĞ 🙂" };' } });
  await win.NOH.ready; await win.NOH.idle();
  assert.deepEqual(logs, ["çğıöşü İĞ 🙂"]);
  await win.NOH.destroy();
});
await t("addLibrary({code}) programatik yükleme", async () => {
  const { win, logs } = load({ scripts: [{ text: 'console.log("ok")' }] });
  await win.NOH.ready;
  await win.NOH.addLibrary({ name: "inline", code: "module.exports = 7;" });
  await win.NOH.run('console.log(require("inline") * 6)');
  assert.ok(logs.includes("42"));
  await win.NOH.destroy();
});

console.log("\nhata yönetimi");
await t("indirilemeyen kütüphane: hata bildirilir, sonraki bloklar yine çalışır", async () => {
  const bad = "https://cdn.example/yok.js";
  const { win, logs, errs } = load({
    scripts: [{ src: bad }, { text: 'console.log("devam")' }],
  }, { fetchMap: { [bad]: 404 } });
  const ev = []; win.NOH.on("error", (e) => ev.push(e.message));
  await win.NOH.ready; await win.NOH.idle();
  assert.ok(ev.some((m) => /indirilemedi.*404/.test(m)));
  assert.ok(errs.some((m) => /indirilemedi/.test(m)));
  assert.ok(logs.includes("devam"));
  await win.NOH.destroy();
});
await t("require edilemeyen modül: stderr + çıkış kodu 1", async () => {
  const { win, errs } = load({ scripts: [{ text: 'require("yok-boyle-bir-paket")' }] });
  const ex = []; win.NOH.on("exit", (e) => ex.push(e.code));
  await win.NOH.ready; await win.NOH.idle();
  assert.deepEqual(ex, [1]);
  assert.ok(errs.join("\n").includes("yok-boyle-bir-paket"));
  await win.NOH.destroy();
});
await t("geçersiz kütüphane adı reddedilir (yol/komut enjeksiyonu)", async () => {
  const { win } = load({ scripts: [{ text: "1" }] });
  await win.NOH.ready;
  for (const bad of ["../etc", "a b", "x;rm -rf /", "a/b/c", "$(id)", ""]) {
    await assert.rejects(() => win.NOH.addLibrary({ name: bad, code: "1" }), /geçersiz kütüphane adı|gerekli/, `kabul edildi: ${JSON.stringify(bad)}`);
  }
  await win.NOH.destroy();
});
await t("scoped ad (@org/paket) kabul edilir", async () => {
  const { win } = load({ scripts: [{ text: "1" }] });
  await win.NOH.ready;
  assert.equal(await win.NOH.addLibrary({ name: "@org/paket", code: "module.exports=1" }), "@org/paket");
  await win.NOH.destroy();
});

console.log("\nAPI");
await t("boot() tekrar çağrılırsa aynı Promise (çift VM açılmaz)", async () => {
  const { win } = load({ scripts: [{ text: "1" }] });
  assert.strictEqual(win.NOH.boot(), win.NOH.boot());
  await win.NOH.ready; await win.NOH.destroy();
});
await t("config() boot sonrası hata verir", async () => {
  const { win } = load({ scripts: [{ text: "1" }] });
  await win.NOH.ready;
  assert.throws(() => win.NOH.config({ memoryMB: 64 }), /boot başladıktan sonra/);
  await win.NOH.destroy();
});
await t("data-manual: otomatik başlamaz, elle boot() ile başlar", async () => {
  const { win } = load({ scripts: [{ text: 'console.log("m")' }], nohAttrs: { "data-manual": "" } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(win.NOH._booted, null);
  win.NOH.scan();
  await win.NOH.ready; await win.NOH.idle();
  await win.NOH.destroy();
});
await t("destroy() kuyruktaki işi bitirir, temp dosya sızdırmaz", async () => {
  const listTmp = () => execFileSync("sh", ["-c", "ls /tmp | grep '^noh_' | sort || true"]).toString();
  const before = listTmp();
  const { win, logs } = load({ scripts: [{ text: 'console.log("son")' }] });
  // ready'yi bile beklemeden destroy: kuyruk bitmeli, sonra kapanmalı
  await win.NOH.destroy();
  assert.ok(logs.includes("son"), "kuyruktaki blok çalışmadan kapandı");
  assert.equal(listTmp(), before, "destroy() temp dosya bıraktı");
});
await t("destroy({force:true}) kuyruğu beklemeden kapatır", async () => {
  const { win } = load({ scripts: [{ text: "1" }] });
  await win.NOH.ready;
  await win.NOH.destroy({ force: true });
});
await t("container() çekirdeğe erişim: writeFile/readFile", async () => {
  const { win } = load({ scripts: [{ text: "1" }] });
  const c = await win.NOH.container();
  await c.writeFile(join(WORK, "z.txt"), "veri");
  assert.equal(await c.readTextFile(join(WORK, "z.txt")), "veri");
  await win.NOH.destroy();
});

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass} geçti, ${fail} kaldı`);
process.exit(fail ? 1 : 0);
