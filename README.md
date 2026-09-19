# NOH — Node.js On HTML

Statik bir sitede, **her şeyi kullanıcının bilgisayarında** çalıştırarak, **Node.js için yazılmış** bir kütüphaneyi olduğu gibi kullanmanızı sağlar.

NOH, Node.js'i taklit etmez. Tarayıcıda küçük bir **gerçek Linux çekirdeği** (v86 ile x86 emülasyonu) ve içinde **gerçek Node.js** çalıştırır; üzerine tahmin edilebilir, küçük bir JavaScript API'si koyar.

```
Tarayıcı ── NOH (JS API) ── v86 (x86 → WASM JIT) ── Linux 32-bit ── Node.js
                │                                       │
                └─────────── seri hat + 9p ─────────────┘
```

## Hızlı başlangıç

```js
import { NOH } from "noh";

const noh = new NOH({
  V86: window.V86,                       // libv86.js'ten
  assets: {
    wasm: "/noh/v86.wasm",
    seabios: "/noh/seabios.bin",
    vgabios: "/noh/vgabios.bin",
    initialState: "/noh/noh-state.bin",  // hızlı yol (snapshot)
    // ya da soğuk boot:  bzimage: "/noh/noh-vmlinuz", initrd: "/noh/noh-initramfs.gz"
  },
});

await noh.boot();

const r = await noh.runNode(`
  const crypto = require("crypto");
  console.log(crypto.createHash("sha256").update("noh").digest("hex"));
`);
console.log(r.stdout, r.code);   // çıktı, 0
```

## Script etiketiyle kullanım (önerilen)

Geliştirici tek satırla NOH'u ekler, Node kütüphanesini etiketle verir ve Node kodunu yazar:

```html
<!-- 1) NOH. v86 dosyaları ve imaj, noh.js'in yanından otomatik bulunur. -->
<script src="https://sitemiz.com/cdn/noh.js"></script>

<!-- 2) Node kütüphanesi. Tarayıcı çalıştırmaz; NOH container'a yazar, require("mylib") olur. -->
<script type="text/node" src="https://sitemiz.com/libs/mylib.js" data-name="mylib"></script>

<!-- 3) Node kodu. Gerçek Node.js içinde çalışır. -->
<script type="text/node">
  const lib = require("mylib");
  console.log(lib.hello());
</script>

<pre data-noh-output></pre>   <!-- çıktı buraya da düşer -->
```

Bir `<script type="text/node">` bloğu tarayıcının JS motorunda **çalışmaz**; tarayıcı bilmediği `type`'ı atlar, NOH okuyup container'daki Node'a verir. Bloklar DOM sırasıyla çalışır: kütüphane, kendinden sonraki koddan önce yüklenir.

### Tarayıcı JS'inden erişim

```js
NOH.on("ready",  (e) => console.log("Node", e.node));
NOH.on("stdout", (e) => ...);   // { text, label }
NOH.on("stderr", (e) => ...);
NOH.on("exit",   (e) => ...);   // { code, label }
NOH.on("error",  (e) => ...);

await NOH.ready;                                  // container hazır
const r = await NOH.run("console.log(1+1)");      // { code, stdout, stderr }
await NOH.addLibrary({ name: "x", url: "https://.../x.js" });
await NOH.addLibrary({ name: "y", code: "module.exports = 42" });
const c = await NOH.container();                  // çekirdek: writeFile, readFile, npm, saveSnapshot
await NOH.destroy();                              // önce kuyruğu bitirir
```

### `<script src="noh.js">` ayarları

| Öznitelik | Anlamı |
|---|---|
| `data-base="https://..."` | v86/imaj dosyalarının klasörü (varsayılan: `noh.js`'in klasörü) |
| `data-memory="256"` | Konuk RAM, MB (varsayılan 512) |
| `data-manual` | Otomatik başlama; `NOH.scan()` ve `NOH.boot()` elle çağrılır |

`text/node` etiketi yoksa container **hiç başlatılmaz** (boşuna yüzlerce MB indirilmez).

### Kütüphane sınırları (bilerek açık yazıyorum)

`<script type="text/node" src="...">` **tek dosyalık** bir CommonJS betiğini kurar (`module.exports = ...`). Bu yüzden:

- **Çalışır:** tek dosyaya paketlenmiş kütüphane (esbuild/rollup/webpack ile), ya da hiç dış bağımlılığı olmayan tek dosya.
- **Çalışmaz:** `require("./altdosya")` ile başka dosyalara, ya da `node_modules` bağımlılıklarına dayanan, paketlenmemiş bir npm paketi.
- Bağımlılığı çok olan bir paket için imajı hazırlarken gömün: `NPM_PACKAGES="paket1 paket2" ./tools/build-image.sh`, sonra snapshot alın. Bu en hızlı ve en tahmin edilebilir yoldur.
- `data-name` verilmezse ad dosya adından türetilir (`lodash.min.js` → `lodash`). Geçersiz ad (yol, boşluk, `;` vb.) reddedilir.

## Dosya düzeni (yayın)

```
sitemiz.com/cdn/
  noh.js              ← npm run build ile üretilir (çekirdek + tarayıcı katmanı, tek klasik betik)
  libv86.js  v86.wasm  seabios.bin  vgabios.bin
  noh-state.bin       ← (önerilir) snapshot; yoksa noh-vmlinuz + noh-initramfs.gz ile soğuk boot
```

`npm run build` → `dist/noh.js`. Kaynak: `src/noh.js` (çekirdek) + `src/noh.browser.js` (etiket katmanı).

## Kurulum (bir kez, geliştirici tarafında)

Gereksinim: Docker, Node.js.

```bash
# 1) 32-bit Alpine + Node.js + npm imajını üret  →  dist/noh-vmlinuz, dist/noh-initramfs.gz
NPM_PACKAGES="lodash" ./tools/build-image.sh      # NPM_PACKAGES isteğe bağlı

# 2) v86 dosyalarını dist/ içine koy: libv86.js, v86.wasm, seabios.bin, vgabios.bin
npm i v86     # build/ ve bios/ altından kopyala

# 3) (önerilir) Hızlı açılış için snapshot al
node tools/make-snapshot.mjs && zstd -19 dist/noh-state.bin

# 4) dist/ klasörünü statik hosting'e koy (GitHub Pages, Netlify, S3, ...)
```

Kullanıcıya ulaşan her şey statik dosyadır; sunucu tarafı kod yoktur.

## API

Tüm metotlar `Promise` döndürür; hatalar **her zaman reject** olur (senkron throw yok).

| Metot | Açıklama |
|---|---|
| `await noh.boot()` | Container'ı açar. Snapshot varsa saniyeler, yoksa soğuk boot. |
| `await noh.exec(cmd, {cwd, env, stdin, timeoutMs})` | Kabuk komutu. Döner: `{ code, stdout, stderr }` |
| `await noh.run(cmd, opts)` | `exec` gibi ama `code !== 0` ise `NOHError` fırlatır |
| `await noh.runNode(code, {args, env, stdin, esm})` | JS kodunu gerçek Node ile çalıştırır |
| `await noh.runNodeFile(path, opts)` | Konuktaki bir betiği çalıştırır |
| `await noh.npm("install lodash")` | npm (ağ gerekir, aşağıya bakın) |
| `await noh.writeFile(path, data)` / `readFile` / `readTextFile` | 9p köprüsüyle dosya G/Ç (string veya bayt) |
| `writeFiles({...}, baseDir)`, `mkdir`, `rm`, `ls`, `exists` | Yardımcılar |
| `await noh.saveSnapshot()` | Çalışan durumu `ArrayBuffer` olarak alır |
| `await noh.destroy()` | Kapatır |

### Tahmin edilebilirlik garantileri

- **Sonuç ayrıştırılmıştır.** `stdout`, `stderr`, `code` ayrı gelir; ikili ve ANSI çıktı bozulmaz (çıktı base64 ile taşınır).
- **Sıralıdır.** Tek seri hat vardır; `exec` çağrıları FIFO kuyruğa girer, sonuçlar karışmaz.
- **Kaçış güvenlidir.** Ortam değişkeni adları doğrulanır, değerler ve yollar tek tırnakla kaçırılır.
- **Zaman aşımı vardır.** Her `exec` için `timeoutMs`; aşımda `NOHError { code: "ETIMEDOUT" }`.
- **Ağ varsayılan kapalıdır.** Aynı imaj + aynı girdi → aynı çıktı.
- **Tutarlı hata modeli.** Her metot reject eder, asla senkron throw etmez.

## Ağ (opsiyonel)

Varsayılan kapalıdır. `npm install` gibi işler için ya paketleri imaja önceden gömün (`NPM_PACKAGES=...` veya snapshot almadan önce `noh.npm(...)`), ya da v86'nın WebSocket relay'i ile `networkRelay: "wss://..."` verin. Tarayıcı, doğrudan TCP/UDP açamaz; bu bir tarayıcı kısıtıdır, NOH'un değil.

## Sınırlamalar (bilerek açık yazıyorum)

1. **32-bit.** v86 yalnızca 32-bit x86 çalıştırır, dolayısıyla Node.js **i686 / musl (Alpine)** derlemesidir. Alpine bu mimari için `nodejs` ve `npm` paketlerini sağlar; Node.js'in kendisi resmi 32-bit Linux ikilisi yayınlamaz. Sürüm, Alpine'in x86 dalında ne varsa odur.
2. **Yavaş.** x86 emülasyonu yerel hızın çok altındadır. Hafif betikler, ayrıştırıcılar, dönüştürücüler, şablon motorları, küçük hesaplamalar için uygundur; ağır derleme/bundle işleri için değil.
3. **Ağır varlıklar.** v86 (`v86.wasm` ~ birkaç yüz KB) ve imaj/snapshot (onlarca–yüzlerce MB) indirilir. `zstd`/brotli ve HTTP önbelleği kullanın; snapshot, soğuk boot'a göre açılışı çok kısaltır.
4. **Native eklentiler.** Node için i686/musl'a derlenmiş olması gerekir; glibc'ye bağlı hazır `.node` ikilileri çalışmaz.
5. **Bellek.** Varsayılan 512 MB konuk RAM'i ayrılır (`memoryMB`). Düşük bellekli cihazlarda azaltın.
6. **Seri hat verimi.** Çıktı seri hat üzerinden taşınır; çok büyük çıktılar için dosyaya yazıp `readFile` kullanın.

## Bu depodaki dosyalar

- `src/noh.js` — çekirdek (ES modülü, bağımlılıksız; v86 dışarıdan verilir)
- `src/noh.browser.js` — `<script type="text/node">` katmanı, `window.NOH`
- `tools/bundle.mjs` — ikisini tek klasik `dist/noh.js`'e birleştirir
- `src/noh.d.ts` — TypeScript tipleri
- `tools/build-image.sh` — Docker ile 32-bit Alpine + Node.js imajı
- `tools/make-snapshot.mjs` — boot edilmiş snapshot üretici
- `examples/index.html` — editör + terminal demosu (çekirdek API)
- `examples/script-tag.html` + `examples/mylib.js` — script etiketiyle kullanım
- `test/noh.test.mjs`, `test/browser.test.mjs` — testler (`npm test`)

## Test durumu

`npm test`, gerçek bir `/bin/sh` sürecini seri hat gibi kullanan sahte bir V86 ile 30 çekirdek + 26 tarayıcı katmanı testini çalıştırır (sentinel, stdout/stderr ayrımı, çıkış kodu, UTF-8, ikili veri, kaçış, sıralama, zaman aşımı, 9p dosya köprüsü, `runNode`). **Emülatörün ve imajın kendisi bu testlerde yoktur**; onlar ilk kurulumda `examples/index.html` ile doğrulanmalıdır.

## Lisans

MIT. v86 BSD-2, Alpine ve Node.js kendi lisanslarıyla dağıtılır.
