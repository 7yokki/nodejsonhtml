#!/usr/bin/env bash
# NOH imaj üreticisi
# ------------------
# Çıktı (./dist):
#   noh-vmlinuz        32-bit Linux çekirdeği (Alpine linux-virt, x86)
#   noh-initramfs.gz   Alpine x86 + Node.js + npm içeren initramfs
#   (isteğe bağlı) noh-state.bin.zst  boot edilmiş + hazır snapshot (bkz. make-snapshot.mjs)
#
# Gereksinim: Docker. v86 SADECE 32-bit çalıştırır; bu yüzden platform i386.
#
# Kullanım:
#   ./tools/build-image.sh                # varsayılan: Alpine v3.21 + nodejs + npm
#   ALPINE=v3.21 EXTRA_PKGS="git python3" ./tools/build-image.sh
#   NPM_PACKAGES="lodash zod" ./tools/build-image.sh   # imaja önceden gömülür

set -euo pipefail

ALPINE="${ALPINE:-v3.21}"
EXTRA_PKGS="${EXTRA_PKGS:-}"
NPM_PACKAGES="${NPM_PACKAGES:-}"
OUT="${OUT:-$(pwd)/dist}"

mkdir -p "$OUT"

# Minimal init (PID 1). Not: 'EOF' tırnaklı, bu yüzden kabuk değişkenleri burada genişletilmez.
cat > "$OUT/init" <<'INITEOF'
#!/bin/sh
# NOH init — v86 içinde PID 1.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root LANG=C.UTF-8 TERM=dumb

mount -t proc  proc  /proc 2>/dev/null
mount -t sysfs sysfs /sys  2>/dev/null
mount -t devtmpfs devtmpfs /dev 2>/dev/null || mount -t tmpfs tmpfs /dev
mkdir -p /dev/pts /dev/shm /tmp /run /mnt/host /work
mount -t devpts devpts /dev/pts 2>/dev/null
mount -t tmpfs  tmpfs  /tmp   2>/dev/null
mount -t tmpfs  tmpfs  /run   2>/dev/null

# devtmpfs yoksa elle düğüm yarat (ttyS0 = 4,64)
[ -c /dev/ttyS0 ]  || mknod /dev/ttyS0  c 4 64
[ -c /dev/console ] || mknod /dev/console c 5 1
[ -c /dev/null ]   || mknod /dev/null   c 1 3
[ -c /dev/zero ]   || mknod /dev/zero   c 1 5
[ -c /dev/urandom ] || mknod /dev/urandom c 1 9
[ -c /dev/random ] || mknod /dev/random c 1 8
[ -c /dev/tty ]    || mknod /dev/tty    c 5 0

# 9p paylaşımı (varsa)
mount -t 9p -o trans=virtio,version=9p2000.L host9p /mnt/host 2>/dev/null

hostname noh
cd /work

# Seri hat: yankı kapalı, LF->CRLF dönüşümü kapalı (protokol temiz bayt akışı ister).
stty -F /dev/ttyS0 -echo -onlcr -icrnl 2>/dev/null

# Shell'i seri konsola bağla ve ölürse yeniden başlat.
# PS1/PS2 boş: prompt çıktıya karışmasın. setsid -c: kontrol terminali (job control uyarısını susturur).
export PS1='' PS2='' PS3='' PS4=''
while true; do
  setsid -c /bin/sh </dev/ttyS0 >/dev/ttyS0 2>&1 || setsid /bin/sh </dev/ttyS0 >/dev/ttyS0 2>&1
  sleep 1
done
INITEOF
chmod +x "$OUT/init"

cat > "$OUT/Dockerfile.noh" <<EOF
# 32-bit (i386) Alpine tabanı. v86 64-bit çekirdek desteklemez.
FROM i386/alpine:${ALPINE#v} AS rootfs

RUN apk add --no-cache nodejs npm ca-certificates linux-virt ${EXTRA_PKGS}

# Tahmin edilebilirlik: OpenRC yok, kendi minimal /init'imiz var.
# /init: proc/sys/dev bağla, seri konsol düğümünü yarat, shell'i ttyS0'a bağlayarak başlat.
COPY init /init
RUN chmod +x /init \\
 && echo -n > /etc/motd \\
 && mkdir -p /work /mnt/host /tmp /proc /sys /dev /run

# Önceden gömülecek npm paketleri (isteğe bağlı) — /work/node_modules
RUN if [ -n "${NPM_PACKAGES}" ]; then cd /work && npm init -y >/dev/null && npm install --no-audit --no-fund ${NPM_PACKAGES}; fi

# initramfs: rootfs'i cpio.gz olarak paketle
FROM rootfs AS pack
RUN apk add --no-cache cpio gzip
RUN cd / && find . -xdev \\
      -not -path './proc/*' -not -path './sys/*' -not -path './dev/*' \\
      -not -path './var/cache/*' -not -path './usr/share/man/*' -not -path './usr/share/doc/*' \\
      -not -path './boot/*' -not -path './usr/share/icu/*.dat.bak' \\
      -print0 | cpio --null -o -H newc 2>/dev/null | gzip -9 > /noh-initramfs.gz

FROM scratch AS export
COPY --from=pack /noh-initramfs.gz /noh-initramfs.gz
COPY --from=pack /boot/vmlinuz-virt /noh-vmlinuz
EOF

echo ">> Docker ile i386 imaj derleniyor (Alpine ${ALPINE})..."
docker buildx build --platform linux/386 \
  -f "$OUT/Dockerfile.noh" \
  --target export \
  --output "type=local,dest=$OUT" \
  "$OUT"

rm -f "$OUT/Dockerfile.noh" "$OUT/init"

echo
echo ">> Bitti:"
ls -lh "$OUT"/noh-vmlinuz "$OUT"/noh-initramfs.gz
cat <<'MSG'

Sonraki adımlar:
  1) v86 dosyalarını dist/ içine koyun:  libv86.js, v86.wasm, seabios.bin, vgabios.bin
     (https://github.com/copy/v86 sürümlerinden veya `npm i v86` paketinden)
  2) Ağır dosyalar için ana bilgisayarınızda gzip/brotli açın (statik hosting yeterli).
  3) İsteğe bağlı hızlı açılış:  node tools/make-snapshot.mjs
  4) examples/index.html dosyasını bir statik sunucudan açın.
MSG
