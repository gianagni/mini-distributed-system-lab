// Proteksi DNS rebinding (allowlist header Host) dan validasi Origin untuk request browser yang
// mengubah state. Dipakai API dan dashboard. Lihat docs/AUDIT.md S-2.
//
// DNS rebinding: domain penyerang di-resolve ulang ke 127.0.0.1, sehingga di mata browser halaman
// penyerang menjadi SAME-ORIGIN dengan server lokal dan bisa membaca respons. Satu-satunya jejak
// yang tersisa di server adalah header Host (berisi nama domain penyerang). Maka Host wajib salah
// satu nama yang memang dipakai untuk mencapai server ini.
//
// Aturan (ketat, tanpa wildcard):
//   - Default: localhost, 127.0.0.1, [::1], masing-masing dengan port yang sedang didengar.
//   - Alamat bind spesifik (mis. HOST=10.0.0.5 dengan ALLOW_REMOTE=1) ikut diizinkan.
//     0.0.0.0 dan :: bukan nama host yang sah, jadi tidak pernah masuk allowlist.
//   - Tambahan eksplisit lewat ALLOWED_HOSTS (dipisah koma), mis. port lain hasil SSH forward
//     (`-L 8100:127.0.0.1:3100` -> ALLOWED_HOSTS=127.0.0.1:8100,localhost:8100). Entri tanpa port
//     memakai port yang didengar. Wildcard (*), skema, path, dan userinfo ditolak saat start.
//   - Port 80: browser tidak mengirim port, jadi nama tanpa port juga diterima.

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];
const WILDCARD_BIND = new Set(['0.0.0.0', '::', '[::]']);
// hostname (DNS label/IPv4) atau [IPv6], opsional :port. Tanpa *, /, @, spasi.
const ENTRY_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:(\d{1,5}))?$/;

/** Format alamat bind sebagai nama Host (IPv6 dalam kurung siku). */
function hostName(host) {
  const h = String(host).toLowerCase();
  return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
}

/** Parse ALLOWED_HOSTS. Melempar Error untuk entri yang tidak valid (gagal cepat saat start). */
export function parseAllowedHosts(raw) {
  if (raw === undefined || raw.trim() === '') return [];
  return raw.split(',').map((part) => {
    const e = part.trim().toLowerCase();
    const m = e.match(ENTRY_RE);
    if (!m || e.includes('*')) {
      throw new Error(`ALLOWED_HOSTS: entri tidak valid "${part.trim()}". Format: nama[:port], tanpa wildcard/skema/path`);
    }
    const port = m[6] === undefined ? null : Number(m[6]);
    if (port !== null && (port < 1 || port > 65535)) throw new Error(`ALLOWED_HOSTS: port tidak valid di "${e}"`);
    if (WILDCARD_BIND.has(m[1])) throw new Error(`ALLOWED_HOSTS: ${m[1]} bukan nama host yang sah`);
    return { name: m[1], port };
  });
}

/**
 * @param {{bindHost: string, allowedHosts?: Array<{name: string, port: number|null}>}} opts
 */
export function createHostGuard({ bindHost, allowedHosts = [] }) {
  const names = new Set(LOOPBACK_NAMES);
  const bind = hostName(bindHost);
  if (!WILDCARD_BIND.has(bind)) names.add(bind);

  const cache = new Map();
  /** Himpunan nilai Host yang sah untuk port yang sedang didengar. */
  function allowed(listenPort) {
    let set = cache.get(listenPort);
    if (set) return set;
    set = new Set();
    for (const n of names) {
      set.add(`${n}:${listenPort}`);
      if (listenPort === 80) set.add(n);
    }
    for (const e of allowedHosts) {
      const p = e.port ?? listenPort;
      set.add(`${e.name}:${p}`);
      if (p === 80) set.add(e.name);
    }
    cache.set(listenPort, set);
    return set;
  }

  return {
    allowed,
    /** true kalau header Host persis salah satu nilai yang diizinkan (case-insensitive). */
    hostOk(hostHeader, listenPort) {
      return typeof hostHeader === 'string' && allowed(listenPort).has(hostHeader.toLowerCase());
    },
    /**
     * Untuk request yang mengubah state. Header yang hanya dikirim browser (Origin, Sec-Fetch-Site),
     * kalau ada, harus menunjukkan same-origin. Kalau tidak ada (curl, fetch Node, proxy dashboard),
     * request diterima: klien non-browser tidak tunduk pada CORS dan tidak membawa cookie/kredensial
     * korban, jadi Origin tidak relevan untuknya.
     */
    sameOriginOk(req) {
      const origin = req.headers.origin;
      if (origin !== undefined && origin.toLowerCase() !== `http://${String(req.headers.host).toLowerCase()}`) return false;
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
      return true;
    },
  };
}
