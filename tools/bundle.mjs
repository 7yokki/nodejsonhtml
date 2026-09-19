#!/usr/bin/env node
/**
 * NOH paketleyici
 * ---------------
 * src/noh.js (çekirdek) + src/noh.browser.js (tarayıcı katmanı)
 * => dist/noh.js  (klasik <script>, IIFE, window.NOH tanımlar)
 *
 * Bağımlılık yok; ES modül sözdizimini elle ayıklar. Çekirdek ve tarayıcı
 * dosyası bu betiğin anladığı basit kalıpları kullanmalıdır (bkz. aşağıdaki kontroller).
 *
 * Kullanım:  node tools/bundle.mjs [çıktı-yolu]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = resolve(process.argv[2] || resolve(root, "dist/noh.js"));

let core = readFileSync(resolve(root, "src/noh.js"), "utf8");
let web = readFileSync(resolve(root, "src/noh.browser.js"), "utf8");

/* --- çekirdek: export'ları düşür, isimleri koru --- */
core = core
  .replace(/^export default \w+;\s*$/gm, "")
  .replace(/^export (async function|function|class|const|let|var) /gm, "$1 ");

/* --- tarayıcı: çekirdek import'unu ve export'ları düşür --- */
const importRe = /^import\s+\{[^}]*\}\s+from\s+"\.\/noh\.js";\s*$/m;
if (!importRe.test(web)) throw new Error("bundle: noh.browser.js içinde beklenen import satırı bulunamadı");
web = web.replace(importRe, "const Core = NOH;");

// export { ... } bloğu ve default
web = web.replace(/^export \{[^}]*\};\s*$/gm, "").replace(/^export default \w+;\s*$/gm, "");
web = web.replace(/^export (async function|function|class|const|let|var) /gm, "$1 ");

// import.meta.url klasik betikte sözdizimi hatasıdır; güvenli hale getir.
web = web.replace(/try \{ src = import\.meta\.url; \} catch \(_\) \{\}/g, "");

// Çekirdek sınıfı, tarayıcı katmanında "Core" adıyla kullanılıyor; NOH adı çekirdeğe ait kalsın
// (window.NOH'u install() atar).
const banner = `/*! NOH — Node.js On HTML | gerçek Node.js, tarayıcıda (v86) | MIT */\n`;
const body = `${banner}(function () {\n"use strict";\n\n/* ---- çekirdek ---- */\n${core}\n\n/* ---- tarayıcı katmanı ---- */\n${web}\n\ninstall(window);\n})();\n`;

// Sözdizimi doğrulaması: klasik betik olarak ayrıştırılabilmeli
try { new Function(body); } catch (e) { throw new Error("bundle: çıktı klasik betik olarak geçerli değil: " + e.message); }
if (/\b(import|export)\s/.test(body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/`[^`]*`/g, "").replace(/"[^"\n]*"/g, "").replace(/'[^'\n]*'/g, ""))) {
  throw new Error("bundle: çıktıda artık import/export kalmış");
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, body);
console.error(`>> ${out}  (${(body.length / 1024).toFixed(1)} KB)`);
