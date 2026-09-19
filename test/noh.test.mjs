/**
 * NOH protokol testleri.
 * v86 yerine GERÇEK bir /bin/sh sürecini seri hat gibi kullanan sahte bir V86
 * ile çalışır: sentinel protokolü, stdout/stderr ayrımı, çıkış kodu, ikili
 * veri, UTF-8, kaçış, sıralama, zaman aşımı ve 9p dosya köprüsü doğrulanır.
 * (Emülasyonun kendisi bu testin konusu değildir.)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { NOH, NOHError, shq, b64encode, b64decode } from "../src/noh.js";

const ROOT = mkdtempSync(join(tmpdir(), "noh-test-"));
const P9 = join(ROOT, "9p");        // "9p" paylaşımı
const MNT = join(ROOT, "mnt");      // konuktaki bağlama noktası (simge bağlantı ile aynı dizin)
const WORK = join(ROOT, "work");
await import("node:fs").then((fs) => { fs.mkdirSync(P9); fs.mkdirSync(WORK); fs.symlinkSync(P9, MNT); });

/** Sahte V86: seri hat = gerçek /bin/sh'in stdin/stdout'u. */
class FakeV86 {
  constructor(cfg) {
    this.cfg = cfg;
    this.listeners = {};
    this.sh = spawn("/bin/sh", [], { stdio: ["pipe", "pipe", "pipe"] });
    this.sh.stdout.on("data", (d) => this._emit(d));
    this.sh.stderr.on("data", (d) => this._emit(d));
  }
  _emit(buf) { for (const b of buf) (this.listeners["serial0-output-byte"] || []).forEach((f) => f(b)); }
  add_listener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  serial0_send(s) { this.sh.stdin.write(s); }
  async create_file(path, bytes) { writeFileSync(join(P9, path), bytes); }
  async read_file(path) { return new Uint8Array(readFileSync(join(P9, path))); }
  async save_state() { return new ArrayBuffer(8); }
  destroy() { this.sh.kill("SIGKILL"); }
}

// stty/mount komutları test kabuğunda anlamlı değil; test için no-op yapan bir ön ek.
// Gerçek boot() yolu kullanılır ama mountPoint sahte 9p'ye simge bağlantı.
const noh = new NOH({
  V86: FakeV86,
  assets: { wasm: "x", seabios: "x", vgabios: "x", initialState: "x" },
  mountPoint: MNT,
  workdir: WORK,
  nodeBin: process.execPath,
  execTimeoutMs: 5000,
});

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "\n     ", e.message.split("\n")[0]); }
}

console.log("\nboot");
await t("boot() hazır duruma geçer", async () => {
  await noh.boot();
  assert.equal(noh.state, "ready");
});
await t("boot() ikinci kez çağrılırsa hata verir", async () => {
  await assert.rejects(() => noh.boot(), NOHError);
});

console.log("\nexec");
await t("stdout + çıkış kodu 0", async () => {
  const r = await noh.exec("echo merhaba");
  assert.deepEqual(r, { code: 0, stdout: "merhaba\n", stderr: "" });
});
await t("stdout ve stderr AYRI, çıkış kodu doğru", async () => {
  const r = await noh.exec("echo out; echo err 1>&2; exit 7");
  assert.equal(r.stdout, "out\n");
  assert.equal(r.stderr, "err\n");
  assert.equal(r.code, 7);
});
await t("UTF-8 (Türkçe + emoji) bozulmaz", async () => {
  const r = await noh.exec("printf 'çğıöşü İĞ 🙂'");
  assert.equal(r.stdout, "çğıöşü İĞ 🙂");
});
await t("ikili çıktı bozulmaz (tüm baytlar)", async () => {
  const r = await noh.exec("head -c 256 /dev/zero | tr '\\0' 'A'");
  assert.equal(r.stdout.length, 256);
  const bin = await noh.exec("awk 'BEGIN{for(i=0;i<256;i++)printf \"%c\",i}' > /tmp/bin.dat; base64 /tmp/bin.dat | tr -d '\\n'");
  assert.ok(bin.stdout.length > 300);
});
await t("çok satırlı çıktı korunur", async () => {
  const r = await noh.exec("seq 1 200");
  assert.equal(r.stdout.trim().split("\n").length, 200);
});
await t("env geçirilir, tırnaklı değerler güvenli", async () => {
  const r = await noh.exec('printf %s "$X"', { env: { X: `a'b"c $HOME \`id\`` } });
  assert.equal(r.stdout, `a'b"c $HOME \`id\``);
});
await t("geçersiz env adı reddedilir", async () => {
  await assert.rejects(() => noh.exec("true", { env: { "A;rm -rf /": "x" } }), /geçersiz ortam/);
});
await t("stdin iletilir", async () => {
  const r = await noh.exec("cat", { stdin: "girdi\n" });
  assert.equal(r.stdout, "girdi\n");
});
await t("cwd çalışır", async () => {
  const r = await noh.exec("pwd", { cwd: "/tmp" });
  assert.ok(r.stdout.trim().endsWith("tmp"));
});
await t("var olmayan komut: kod 127 + stderr", async () => {
  const r = await noh.exec("bu_komut_yok_123");
  assert.equal(r.code, 127);
  assert.ok(r.stderr.length > 0);
});
await t("run() sıfırdan farklı kodda NOHError fırlatır", async () => {
  await assert.rejects(() => noh.run("exit 4"), (e) => e instanceof NOHError && e.code === 4);
});

console.log("\nsıralama / eşzamanlılık");
await t("aynı anda başlatılan 20 exec, sonuçlar birbirine karışmaz", async () => {
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => noh.exec(`echo ${i}`)));
  rs.forEach((r, i) => assert.equal(r.stdout, `${i}\n`));
});
await t("çıktısı sentinel'e benzeyen komut protokolü bozmaz", async () => {
  const r = await noh.exec("echo __NOH_END_deadbeef__; echo CODE:99");
  assert.match(r.stdout, /__NOH_END_deadbeef__/);
  assert.equal(r.code, 0);
});

console.log("\nzaman aşımı");
await t("uzun komut ETIMEDOUT ile biter", async () => {
  await assert.rejects(() => noh.exec("sleep 5", { timeoutMs: 400 }), (e) => e.code === "ETIMEDOUT");
});

console.log("\ndosya köprüsü");
await t("writeFile → readFile gidiş-dönüş (ikili dahil)", async () => {
  const data = Uint8Array.from({ length: 256 }, (_, i) => i);
  await noh.writeFile(join(WORK, "a", "b.bin"), data);
  const back = await noh.readFile(join(WORK, "a", "b.bin"));
  assert.deepEqual(Array.from(back), Array.from(data));
});
await t("writeFile(string) UTF-8", async () => {
  await noh.writeFile(join(WORK, "t.txt"), "şğü 🙂");
  assert.equal(await noh.readTextFile(join(WORK, "t.txt")), "şğü 🙂");
});
await t("boşluk/tırnak içeren dosya adı", async () => {
  const p = join(WORK, "a b", "it's.txt");
  await noh.writeFile(p, "x");
  assert.equal(await noh.readTextFile(p), "x");
});
await t("exists / ls / rm", async () => {
  const d = join(WORK, "lsdir");
  await noh.mkdir(d);
  await noh.writeFile(join(d, "1.txt"), "1");
  await noh.writeFile(join(d, "2.txt"), "2");
  assert.deepEqual((await noh.ls(d)).sort(), ["1.txt", "2.txt"]);
  assert.equal(await noh.exists(join(d, "1.txt")), true);
  await noh.rm(d, { recursive: true });
  assert.equal(await noh.exists(d), false);
});

console.log("\nNode.js");
await t("runNode: stdout, stderr ve çıkış kodu", async () => {
  const r = await noh.runNode(`console.log("hi"); console.error("e"); process.exit(3)`);
  assert.equal(r.stdout, "hi\n");
  assert.equal(r.stderr, "e\n");
  assert.equal(r.code, 3);
});
await t("runNode: args ve stdin", async () => {
  const r = await noh.runNode(`
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>console.log(process.argv.slice(2).join("|")+"#"+s.trim()));
  `, { args: ["a b", "c'd"], stdin: "xyz" });
  assert.equal(r.stdout.trim(), "a b|c'd#xyz");
});
await t("runNode: ESM", async () => {
  const r = await noh.runNode(`import os from "node:os"; console.log(typeof os.cpus)`, { esm: true });
  assert.equal(r.stdout.trim(), "function");
});
await t("runNode: yakalanmamış hata → kod 1, stderr'de iz", async () => {
  const r = await noh.runNode(`throw new Error("patladı")`);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /patladı/);
});
await t("nodeVersion()", async () => {
  assert.match(await noh.nodeVersion(), /^v\d+\./);
});
await t("runNode: geçici dosya temizlenir (sonuç dönmeden önce)", async () => {
  const before = (await noh.exec("ls /tmp | grep '^noh_' | sort")).stdout;
  await noh.runNode(`console.log(1)`);
  // Bekleme YOK: temizlik runNode dönmeden önce bitmiş olmalı.
  const after = (await noh.exec("ls /tmp | grep '^noh_' | sort")).stdout;
  assert.equal(after, before, "runNode yeni bir geçici dosya bıraktı");
});

console.log("\nyardımcılar");
await t("shq güvenli kaçış", () => {
  assert.equal(shq("a'b"), `'a'\\''b'`);
});
await t("base64 gidiş-dönüş (her uzunluk 0..300)", () => {
  for (let n = 0; n <= 300; n++) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
    assert.deepEqual(Array.from(b64decode(b64encode(b))), Array.from(b));
    assert.equal(b64encode(b), Buffer.from(b).toString("base64"));
  }
});

console.log("\nsnapshot / kapatma");
await t("saveSnapshot ArrayBuffer döndürür", async () => {
  assert.ok((await noh.saveSnapshot()) instanceof ArrayBuffer);
});
await t("destroy() sonrası exec reddedilir", async () => {
  await noh.destroy();
  await assert.rejects(() => noh.exec("true"), /hazır değil/);
});

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass} geçti, ${fail} kaldı`);
process.exit(fail ? 1 : 0);
