// Örnek "Node kütüphanesi": require, module.exports, Node çekirdek modülleri kullanır.
const os = require("os");
const crypto = require("crypto");

module.exports = {
  selamla(ad) {
    const id = crypto.createHash("sha1").update(ad).digest("hex").slice(0, 8);
    return `merhaba ${ad} (id=${id}, ${os.platform()})`;
  },
};
