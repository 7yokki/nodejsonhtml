#!/usr/bin/env node
/**
 * NOH snapshot üreticisi
 * ----------------------
 * Soğuk boot uzun sürer (v86 x86'yı JIT ile emüle eder). Bir kez boot edip
 * "hazır" durumu kaydederseniz, kullanıcılar snapshot'ı yükleyip saniyeler
 * içinde çalışan bir Node.js ile başlar.
 *
 * Kullanım:
 *   npm i v86            # (Node.js'te v86 çalışır)
 *   node tools/make-snapshot.mjs [dist-dizini]
 *
 * Girdi : dist/noh-vmlinuz, dist/noh-initramfs.gz
 * Çıktı : dist/noh-state.bin   (+ sıkıştırmak için: zstd -19 dist/noh-state.bin)
 *
 * Not: Ekstra npm paketlerini de burada kurup ("await noh.npm('i ...')")
 * SONRA snapshot alırsanız onlar da snapshot'ın içinde gelir.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.argv[2] || resolve(here, "../dist"));

let V86;
try {
  ({ V86 } = await import("v86"));
} catch {
  console.error("v86 bulunamadı. Önce:  npm i v86");
  process.exit(1);
}

// v86 paketinin build dosyalarını bul (node_modules/v86/build ya da bios/)
const v86Dir = dirname(require.resolve("v86/package.json"));
const pick = (...c) => c.map((p) => resolve(v86Dir, p)).find((p) => { try { readFileSync(p); return true; } catch { return false; } });

// Önce dist/ (elle koyduğunuz dosyalar), sonra v86 paketi.
const pickDist = (n) => { const p = resolve(dist, n); try { readFileSync(p); return p; } catch { return null; } };
const wasm = pickDist("v86.wasm") || pick("build/v86.wasm", "v86.wasm");
const seabios = pickDist("seabios.bin") || pick("bios/seabios.bin", "seabios.bin");
const vgabios = pickDist("vgabios.bin") || pick("bios/vgabios.bin", "vgabios.bin");
const missing = [["v86.wasm", wasm], ["seabios.bin", seabios], ["vgabios.bin", vgabios]].filter(([, p]) => !p).map(([n]) => n);
if (missing.length) {
  console.error("Bulunamadı: " + missing.join(", "));
  console.error("dist/ içine koyun. BIOS dosyaları: https://github.com/copy/v86/tree/master/bios");
  process.exit(1);
}

const emu = new V86({
  wasm_path: wasm,
  memory_size: 512 * 1024 * 1024,
  vga_memory_size: 2 * 1024 * 1024,
  bios: { buffer: readFileSync(seabios).buffer },
  vga_bios: { buffer: readFileSync(vgabios).buffer },
  bzimage: { buffer: readFileSync(resolve(dist, "noh-vmlinuz")).buffer },
  initrd: { buffer: readFileSync(resolve(dist, "noh-initramfs.gz")).buffer },
  cmdline: "rw console=ttyS0 rdinit=/init quiet loglevel=3 tsc=reliable mitigations=off random.trust_cpu=on",
  filesystem: {},
  autostart: true,
  disable_keyboard: true,
  disable_mouse: true,
  disable_speaker: true,
});

let buf = "";
emu.add_listener("serial0-output-byte", (b) => {
  process.stderr.write(String.fromCharCode(b));
  buf += String.fromCharCode(b);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(needle, ms) {
  const t0 = Date.now();
  while (!buf.includes(needle)) {
    if (Date.now() - t0 > ms) throw new Error(`zaman aşımı: ${needle}`);
    await sleep(100);
  }
}

console.error("\n>> Boot bekleniyor…");

// Not: terminal komutu yankılar; bu yüzden aradığımız değerler komut metninde
// BİRLEŞİK görünmez, yalnızca kabuğun ürettiği gerçek çıktıda görünür.

// 1) Kabuk cevap veriyor mu? printf ile iki parçadan birleşen bir değer basıyoruz.
const iv = setInterval(() => emu.serial0_send("printf '%s%s\\n' __NOH_ALIVE __YES\n"), 2000);
await waitFor("__NOH_ALIVE__YES", 10 * 60_000);
clearInterval(iv);
console.error("\n>> Kabuk cevap veriyor.");

// 2) Node'u GERÇEKTEN çalıştır ve sürümünü oku.
buf = "";
emu.serial0_send("mkdir -p /work /mnt/host; printf '%s%s\\n' NODEVER= \"$(node --version 2>&1)\"\n");
await sleep(500);
await waitFor("NODEVER=v", 90_000).catch(() => {});
const m = buf.match(/NODEVER=(v\d+\.\S*)/);
if (!m) {
  console.error("\n>> HATA: Node sürümü okunamadı. Son çıktı:\n" + buf.slice(-400));
  await emu.destroy();
  process.exit(2);
}
console.error("\n>> Node çalışıyor: " + m[1]);

// Kabuk zaten init tarafından temiz ayarlandı (yankı kapalı, prompt boş).
// Snapshot'a bekleyen çıktı girmesin diye kısa bir sessizlik bekle.
await sleep(1500);

console.error(">> Snapshot alınıyor…");
const state = await emu.save_state();
const out = resolve(dist, "noh-state.bin");
writeFileSync(out, Buffer.from(state));
console.error(`>> Yazıldı: ${out}  (${(state.byteLength / 1048576).toFixed(1)} MB)`);
console.error(">> İpucu: zstd -19 noh-state.bin  ile küçültüp barındırın.");

await emu.destroy();
process.exit(0);
