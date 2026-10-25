// SoloLatino (sololatino.net) — port para la app (contrato lol.json / CommonJS) — v0.2.0
//
// Ids: "pelicula/<slug>" y "serie/<slug>"; un episodio es "serie/<slug>#<temporada>x<episodio>".
// La app no ofrece kino.crypto / kino.cookies / kino.storage / kino.browser, así que aquí van
// SHA-256 y AES-256-CBC en JS puro, las cookies se leen de la cabecera set-cookie y la caché es
// en memoria. Servidores sin extractor (Filemoon, MixDrop…) se omiten: necesitarían el navegador.

const SITE = "https://sololatino.net";
const EMBED_SITE = "https://embed69.org";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HLS_RE = /\.m3u8/i;
const CACHE_MS = 10 * 60 * 1000;
const MAX_COPIES = 8;
const RESOLVE_BUDGET_MS = 35000;
const GRACE_MS = 4000;

const GENRES = [
  ["accion", "Acción"], ["animacion", "Animación"], ["aventura", "Aventura"], ["belica", "Bélica"],
  ["ciencia-ficcion", "Ciencia Ficción"], ["comedia", "Comedia"], ["crimen", "Crimen"],
  ["documental", "Documental"], ["drama", "Drama"], ["familia", "Familia"], ["fantasia", "Fantasía"],
  ["historia", "Historia"], ["misterio", "Misterio"], ["musica", "Música"], ["romance", "Romance"],
  ["suspense", "Suspense"], ["terror", "Terror"], ["western", "Western"],
];
const NETWORKS = [
  ["netflix", "Netflix"], ["amazon-prime-video", "Amazon Prime Video"], ["disney", "Disney+"],
  ["hbo-max", "HBO Max"], ["hbo", "HBO"], ["apple-tv", "Apple TV+"], ["hulu", "Hulu"], ["nbc", "NBC"],
];
const LISTS = {
  peliculas: { path: "/peliculas", title: "Películas recientes" },
  populares: { path: "/peliculas", query: "sort=popular", title: "Películas populares" },
  series: { path: "/series", title: "Series recientes" },
  mejores: { path: "/series", query: "sort=rating", title: "Series mejor valoradas" },
  animes: { path: "/animes", title: "Anime" },
  doramas: { path: "/doramas", title: "Doramas" },
};

// ---------------------------------------------------------------------------------------------
// Utilidades

function mkErr(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}
function log() {
  try {
    console.log.apply(console, ["sololatino:"].concat(Array.prototype.slice.call(arguments)));
  } catch (_) {}
}
function cfg(key) {
  const g = globalThis.__nuvioConfig || {};
  const c = g.sololatino || g.current || {};
  return c[key] == null ? "" : String(c[key]);
}
function kfetch(url, opts) {
  opts = opts || {};
  const ms = opts.timeoutMs;
  const o = Object.assign({}, opts);
  delete o.timeoutMs;
  const p = fetch(url, o);
  if (!ms) return p;
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error("timeout " + ms + "ms")); }, ms);
    p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}
function originOf(url) {
  const m = String(url).match(/^(https?:\/\/[^\/?#]+)/i);
  return m ? m[1] : null;
}
function hostnameOf(url) {
  const o = originOf(url);
  return o ? o.replace(/^https?:\/\//i, "").replace(/:\d+$/, "").toLowerCase() : "";
}
function absolute(href, base) {
  href = String(href);
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(href)) return href;
  const m = String(base).match(/^([a-zA-Z][a-zA-Z0-9+.\-]*:)\/\/([^\/?#]*)([^?#]*)/);
  if (!m) return null;
  if (href.indexOf("//") === 0) return m[1] + href;
  const origin = m[1] + "//" + m[2];
  if (href.charAt(0) === "/") return origin + href;
  const segs = (m[3].replace(/[^\/]*$/, "") + href).split("/");
  const out = [];
  for (const s of segs) {
    if (s === "..") out.pop();
    else if (s !== ".") out.push(s);
  }
  return origin + out.join("/");
}

const memo = {};
async function cached(key, fn) {
  const hit = memo[key];
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;
  const v = await fn();
  if (!(Array.isArray(v) && !v.length)) memo[key] = { t: Date.now(), v: v };
  return v;
}

async function getPage(url, headers) {
  const r = await kfetch(url, {
    headers: Object.assign({ "User-Agent": UA, "Accept-Language": "es-MX,es;q=0.9" }, headers || {}),
    timeoutMs: 15000,
  });
  if (!r.ok) throw mkErr("unavailable", "SoloLatino " + r.status + " " + url);
  return r.text();
}

// ---------------------------------------------------------------------------------------------
// Parseo de HTML

const decode = function (s) {
  return String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
};
const text = function (s) {
  return decode(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
};

function parseCards(html) {
  const out = [];
  const seen = new Set();
  const parts = String(html || "").split('<div class="card">').slice(1);
  for (const c of parts) {
    const href = /href="https:\/\/sololatino\.net\/(pelicula|serie)\/([^"\/?#]+)"/.exec(c);
    if (!href || seen.has(href[1] + href[2])) continue;
    seen.add(href[1] + href[2]);
    const title = /<p class="card__title">([\s\S]*?)<\/p>/.exec(c) || /<span class="card__title">([\s\S]*?)<\/span>/.exec(c);
    const img = /<img[^>]*?src="([^"]+)"/.exec(c);
    const year = /class="card__year">\s*(\d{4})/.exec(c);
    const badge = /badge card__badge badge-(\w+)">([^<]*)/.exec(c);
    const rating = /card__rating">[^\d]*([\d.]+)/.exec(c);
    out.push({
      slug: href[2],
      kind: href[1] === "pelicula" ? "movie" : "series",
      type: badge ? badge[1] : "",
      title: title ? text(title[1]) : href[2],
      year: year ? Number(year[1]) : undefined,
      poster: img ? img[1] : "",
      rating: rating ? Number(rating[1]) : undefined,
    });
  }
  return out;
}

function parseTitle(html) {
  const h = String(html || "");
  const t2 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(h);
  if (!t2) return null;
  const para = /<p class="text-sm leading-relaxed[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(h.slice(t2.index));
  const head = h.slice(t2.index, para ? t2.index + para.index : t2.index + 6000);
  const poster = /<img src="([^"]+)"[^>]*class="w-44/.exec(h);
  const back = /detail-hero__bg"[^>]*style="[^"]*url\('([^']+)'\)/.exec(h);
  const genres = Array.from(new Set(
    Array.from(head.matchAll(/<a href="https:\/\/sololatino\.net\/genero\/[^"]+"[^>]*>\s*([^<]+?)\s*<\/a>/g)).map(function (m) { return text(m[1]); })
  ));
  const spans = Array.from(head.matchAll(/<span[^>]*>([^<]*)<\/span>/g)).map(function (m) { return text(m[1]); });
  const year = spans.find(function (x) { return /^\d{4}$/.test(x); });
  const runtime = spans.find(function (x) { return /^\d+h( \d+m)?$|^\d+ ?m(in)?$/.test(x); });
  const rate = /([\d.]+)\/10/.exec(head) || /rating-badge__val">([\d.]+)/.exec(head);
  const seasons = [];
  for (const p of h.split('data-season-panel="').slice(1)) {
    const season = Number(p.slice(0, p.indexOf('"')));
    const eps = [];
    for (const e of p.split('<a href="https://sololatino.net/serie/').slice(1)) {
      const link = /^[^"\/]+\/temporada-(\d+)\/episodio-(\d+)"/.exec(e);
      if (!link) continue;
      const name = /<p class="text-sm font-semibold text-white leading-tight">([\s\S]*?)<\/p>/.exec(e);
      const thumb = /<img src="([^"]+)"/.exec(e);
      const plot = /<p class="text-xs mt-1 line-clamp-2"[^>]*>([\s\S]*?)<\/p>/.exec(e);
      eps.push({
        season: Number(link[1]),
        number: Number(link[2]),
        title: name ? text(name[1]) : "",
        thumb: thumb ? thumb[1] : "",
        overview: plot ? text(plot[1]) : "",
      });
    }
    if (eps.length) seasons.push({ season: season, episodes: eps });
  }
  const ogm = /<meta property="og:image" content="([^"]*)"/.exec(h);
  return {
    title: text(t2[1]),
    overview: para ? text(para[1]) : "",
    year: year ? Number(year) : undefined,
    rating: rate ? Number(rate[1]) : undefined,
    genres: genres,
    poster: poster ? poster[1] : ogm ? decode(ogm[1]) : "",
    backdrop: back ? back[1] : "",
    seasons: seasons,
  };
}

function parsePlayers(html) {
  const out = [];
  for (const g of String(html || "").split('data-lang-group="').slice(1)) {
    const lang = g.slice(0, g.indexOf('"'));
    for (const b of g.matchAll(/data-player-token="([^"]+)"[^>]*>\s*([^<]*?)\s*<\/button>/g)) {
      out.push({ lang: lang, name: text(b[2]), token: b[1] });
    }
  }
  return out;
}
function embedId(url) {
  const m = /\/f\/(tt\d+(?:-\d+x\d+)?)/.exec(String(url || ""));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------------------------
// Items, listas, home

function toItem(card, genreName) {
  const item = {
    id: (card.kind === "movie" ? "pelicula/" : "serie/") + card.slug,
    title: card.title,
    type: card.kind,
  };
  if (card.poster) {
    item.poster = card.poster;
    item.backdrop = card.poster;
  }
  if (card.year) item.year = String(card.year);
  if (card.rating) item.rating = card.rating;
  const kindGenre = { anime: "Anime", dorama: "Dorama", toon: "Animación" }[card.type];
  const g = [kindGenre, genreName].filter(Boolean);
  if (g.length) item.genres = g;
  return item;
}

// ref: "list:<k>" | "genre:<slug>" | "net:<slug>"
function defOf(ref) {
  const m = /^(list|genre|net):([a-z0-9-]+)$/.exec(String(ref || ""));
  if (!m) return null;
  if (m[1] === "list") return LISTS[m[2]] || null;
  if (m[1] === "genre") {
    const g = GENRES.find(function (x) { return x[0] === m[2]; });
    return g ? { path: "/genero/" + g[0], title: g[1], genreName: g[1] } : null;
  }
  const n = NETWORKS.find(function (x) { return x[0] === m[2]; });
  return n ? { path: "/red/" + n[0], title: n[1] } : null;
}

async function listPage(def, page) {
  const qs = [def.query, page > 1 ? "page=" + page : ""].filter(Boolean).join("&");
  const url = SITE + def.path + (qs ? "?" + qs : "");
  const cards = await cached("l:" + def.path + ":" + qs, async function () { return parseCards(await getPage(url)); });
  return { cards: cards, more: cards.length >= 24 };
}

async function rowOf(id, ref, style) {
  const def = defOf(ref);
  const r = await listPage(def, 1);
  const items = r.cards.slice(0, 20).map(function (c) { return toItem(c, def.genreName); });
  return items.length
    ? { id: id, title: def.title, type: "row", imageStyle: style || "poster", catalogId: ref, items: items }
    : null;
}
async function safeRow(id, ref) {
  try {
    return await rowOf(id, ref);
  } catch (e) {
    log("row " + id + ": " + (e && e.message));
    return null;
  }
}

async function getHome() {
  const rows = (await Promise.all([
    safeRow("peliculas", "list:peliculas"),
    safeRow("series", "list:series"),
    safeRow("animes", "list:animes"),
    safeRow("doramas", "list:doramas"),
    safeRow("populares", "list:populares"),
    safeRow("netflix", "net:netflix"),
  ])).filter(Boolean);
  if (!rows.length) throw mkErr("unavailable", "home: sin filas");
  // Hero: lo más popular (o lo primero que haya).
  const src = rows.find(function (r) { return r.id === "populares"; }) || rows[0];
  rows.unshift({ id: "hero", title: "Destacados", type: "hero", imageStyle: "backdrop", items: src.items.slice(0, 6) });
  return rows;
}

async function getCatalogs() {
  return [].concat(
    Object.keys(LISTS).map(function (k) { return { id: "list:" + k, title: LISTS[k].title }; }),
    GENRES.map(function (g) { return { id: "genre:" + g[0], title: g[1] }; }),
    NETWORKS.map(function (n) { return { id: "net:" + n[0], title: n[1] }; })
  );
}

async function getCatalog(catalogId, opts) {
  const def = defOf(catalogId);
  if (!def) return { items: [], hasMore: false };
  const page = Math.max(1, parseInt(opts && opts.page, 10) || 1);
  const r = await listPage(def, page);
  return {
    items: r.cards.map(function (c) { return toItem(c, def.genreName); }),
    hasMore: r.more,
    page: page,
  };
}

async function getDiscoverFilters() {
  const listOpts = Object.keys(LISTS).map(function (k) { return { id: k, label: LISTS[k].title }; });
  return [
    { id: "lista", label: "Lista", options: listOpts },
    { id: "genero", label: "Género", options: [{ id: "todos", label: "Todos" }].concat(GENRES.map(function (g) { return { id: g[0], label: g[1] }; })) },
    { id: "plataforma", label: "Plataforma", options: [{ id: "todas", label: "Todas" }].concat(NETWORKS.map(function (n) { return { id: n[0], label: n[1] }; })) },
  ];
}

async function getDiscover(opts) {
  opts = opts || {};
  const plataforma = String(opts.plataforma || "todas");
  const genero = String(opts.genero || "todos");
  let ref;
  if (plataforma !== "todas") ref = "net:" + plataforma;
  else if (genero !== "todos") ref = "genre:" + genero;
  else ref = "list:" + String(opts.lista || "peliculas");
  return getCatalog(ref, { page: opts.page });
}

async function search(query) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];
  const rows = await cached("s:" + q.toLowerCase(), async function () {
    const r = await kfetch(SITE + "/api/search/suggest?q=" + encodeURIComponent(q), {
      headers: { "User-Agent": UA, Accept: "application/json" },
      timeoutMs: 15000,
    });
    if (!r.ok) throw mkErr("unavailable", "SoloLatino search " + r.status);
    const data = JSON.parse(await r.text());
    return Array.isArray(data) ? data : [];
  });
  const items = [];
  for (const x of rows) {
    const m = /sololatino\.net\/(pelicula|serie)\/([^\/?#]+)/.exec(String((x && x.url) || ""));
    if (!m || x.type === "person") continue;
    items.push(toItem({
      slug: m[2],
      kind: m[1] === "pelicula" ? "movie" : "series",
      type: String(x.type || ""),
      title: String(x.title || m[2]),
      year: Number(x.year) || undefined,
      poster: String(x.poster || ""),
    }));
  }
  return items.slice(0, 40);
}

// ---------------------------------------------------------------------------------------------
// Detalle y episodios

function splitId(id) {
  const s = String(id);
  const hash = s.indexOf("#");
  const base = hash >= 0 ? s.slice(0, hash) : s;
  const parts = base.split("/");
  const fm = hash >= 0 ? /^(\d+)x(\d+)$/.exec(s.slice(hash + 1)) : null;
  return {
    base: base,
    kind: parts[0],
    slug: parts[1],
    season: fm ? Number(fm[1]) : null,
    episode: fm ? Number(fm[2]) : null,
  };
}

function titlePage(kind, slug) {
  return cached("p:" + kind + slug, async function () {
    return parseTitle(await getPage(SITE + "/" + (kind === "pelicula" ? "pelicula" : "serie") + "/" + slug));
  });
}

async function getMeta(id) {
  const p = splitId(id);
  if ((p.kind !== "pelicula" && p.kind !== "serie") || !p.slug) throw mkErr("not_found", "id inválido " + id);
  const page = await titlePage(p.kind, p.slug);
  if (!page) throw mkErr("not_found", "ficha no disponible: " + p.base);
  const meta = {
    id: p.base,
    title: page.title,
    type: p.kind === "pelicula" ? "movie" : "series",
    overview: page.overview,
    poster: page.poster || undefined,
    backdrop: page.backdrop || page.poster || undefined,
    genres: page.genres,
  };
  if (page.year) meta.year = String(page.year);
  if (page.rating) meta.rating = page.rating;
  if (p.kind === "serie") {
    if (!page.seasons.length) throw mkErr("not_found", "sin episodios: " + p.base);
    meta.seasons = page.seasons.map(function (s) {
      return {
        number: s.season,
        name: "Temporada " + s.season,
        episodes: s.episodes.map(function (e) {
          return {
            number: e.number,
            id: p.base + "#" + e.season + "x" + e.number,
            title: e.title || "Episodio " + e.number,
            overview: e.overview || undefined,
            still: e.thumb || undefined,
          };
        }),
      };
    });
  }
  return meta;
}

// ---------------------------------------------------------------------------------------------
// SHA-256 (JS puro) — para el proof-of-work de embed69

const SHA_K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const SHA_W = new Int32Array(64);

function sha256Bytes(bytes) {
  const len = bytes.length;
  const total = (((len + 9 + 63) >> 6) << 6);
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const bits = len * 8;
  buf[total - 4] = (bits >>> 24) & 255;
  buf[total - 3] = (bits >>> 16) & 255;
  buf[total - 2] = (bits >>> 8) & 255;
  buf[total - 1] = bits & 255;
  let h0 = 0x6a09e667 | 0, h1 = 0xbb67ae85 | 0, h2 = 0x3c6ef372 | 0, h3 = 0xa54ff53a | 0;
  let h4 = 0x510e527f | 0, h5 = 0x9b05688c | 0, h6 = 0x1f83d9ab | 0, h7 = 0x5be0cd19 | 0;
  const w = SHA_W;
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA_K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach(function (v, i) {
    out[i * 4] = (v >>> 24) & 255;
    out[i * 4 + 1] = (v >>> 16) & 255;
    out[i * 4 + 2] = (v >>> 8) & 255;
    out[i * 4 + 3] = v & 255;
  });
  return out;
}
function asciiBytes(s) {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255;
  return u;
}
function utf8Bytes(s) {
  return asciiBytes(unescape(encodeURIComponent(s)));
}
function toHex(u) {
  let h = "";
  for (let i = 0; i < u.length; i++) h += (u[i] < 16 ? "0" : "") + u[i].toString(16);
  return h;
}
function sha256Hex(str) {
  return toHex(sha256Bytes(utf8Bytes(str)));
}

// ---------------------------------------------------------------------------------------------
// AES-CBC (JS puro, 128 o 256 bits) — solo descifrar

const SBOX_HEX = "637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b27509832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cfd0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdbe0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9ee1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16";
const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  SBOX[i] = parseInt(SBOX_HEX.substr(i * 2, 2), 16);
  INV_SBOX[SBOX[i]] = i;
}
function gmul(a, b) {
  let p = 0;
  while (b) {
    if (b & 1) p ^= a;
    a = ((a << 1) ^ (a & 0x80 ? 0x11b : 0)) & 0xff;
    b >>= 1;
  }
  return p;
}
const M9 = new Uint8Array(256), M11 = new Uint8Array(256), M13 = new Uint8Array(256), M14 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  M9[i] = gmul(i, 9);
  M11[i] = gmul(i, 11);
  M13[i] = gmul(i, 13);
  M14[i] = gmul(i, 14);
}
function expandKey(key) {
  const nk = key.length / 4; // 4 u 8
  const rounds = nk + 6;
  const total = 16 * (rounds + 1);
  const w = new Uint8Array(total);
  w.set(key);
  let rcon = 1;
  for (let i = key.length; i < total; i += 4) {
    let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
    const word = i / 4;
    if (word % nk === 0) {
      const x = t0;
      t0 = SBOX[t1] ^ rcon;
      t1 = SBOX[t2];
      t2 = SBOX[t3];
      t3 = SBOX[x];
      rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0)) & 0xff;
    } else if (nk > 6 && word % nk === 4) {
      t0 = SBOX[t0]; t1 = SBOX[t1]; t2 = SBOX[t2]; t3 = SBOX[t3];
    }
    w[i] = w[i - key.length] ^ t0;
    w[i + 1] = w[i - key.length + 1] ^ t1;
    w[i + 2] = w[i - key.length + 2] ^ t2;
    w[i + 3] = w[i - key.length + 3] ^ t3;
  }
  return { w: w, rounds: rounds };
}
function decryptBlock(ks, input, out) {
  const w = ks.w, rounds = ks.rounds;
  const s = new Uint8Array(16);
  const t = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = input[i] ^ w[rounds * 16 + i];
  for (let round = rounds - 1; round >= 0; round--) {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[((c + r) % 4) * 4 + r] = s[c * 4 + r];
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[t[i]] ^ w[round * 16 + i];
    if (round > 0) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3];
        s[c * 4] = M14[a0] ^ M11[a1] ^ M13[a2] ^ M9[a3];
        s[c * 4 + 1] = M9[a0] ^ M14[a1] ^ M11[a2] ^ M13[a3];
        s[c * 4 + 2] = M13[a0] ^ M9[a1] ^ M14[a2] ^ M11[a3];
        s[c * 4 + 3] = M11[a0] ^ M13[a1] ^ M9[a2] ^ M14[a3];
      }
    }
  }
  out.set(s);
}
function hexBytes(hex) {
  const u = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(hex.substr(i * 2, 2), 16);
  return u;
}
// key: bytes (16/32); iv: 16 bytes; data: bytes múltiplo de 16 -> texto (latin1)
function aesCbcDecrypt(key, iv, data) {
  if (data.length === 0 || data.length % 16 !== 0) throw new Error("bad AES data length");
  const ks = expandKey(key);
  const out = new Uint8Array(data.length);
  const block = new Uint8Array(16);
  let prev = iv;
  for (let off = 0; off < data.length; off += 16) {
    decryptBlock(ks, data.subarray(off, off + 16), block);
    for (let i = 0; i < 16; i++) out[off + i] = block[i] ^ prev[i];
    prev = data.subarray(off, off + 16);
  }
  const pad = out[out.length - 1];
  const end = pad >= 1 && pad <= 16 ? out.length - pad : out.length;
  let s = "";
  for (let i = 0; i < end; i++) s += String.fromCharCode(out[i]);
  return s;
}

// ---------------------------------------------------------------------------------------------
// embed69: proof-of-work + enlaces cifrados

const MAX_DIFFICULTY = 4;
const POW_CAP = 100000;

// Ruta rápida: el mensaje (desafío + número) cabe en un bloque de 64 bytes; se reutiliza el
// buffer y solo se calcula lo necesario para comparar los ceros iniciales (difficulty ≤ 8).
function solvePow(challenge, difficulty) {
  const prefix = utf8Bytes(challenge);
  const maxDigits = String(POW_CAP).length;
  if (prefix.length + maxDigits > 55 || difficulty > 8) {
    const zeros = "0".repeat(difficulty);
    for (let n = 0; n <= POW_CAP; n++) if (sha256Hex(challenge + n).indexOf(zeros) === 0) return n;
    return null;
  }
  const buf = new Uint8Array(64);
  buf.set(prefix);
  const w = new Int32Array(64);
  const shift = 32 - 4 * difficulty;
  for (let n = 0; n <= POW_CAP; n++) {
    const digits = String(n);
    const len = prefix.length + digits.length;
    for (let i = 0; i < digits.length; i++) buf[prefix.length + i] = digits.charCodeAt(i);
    buf[len] = 0x80;
    for (let i = len + 1; i < 62; i++) buf[i] = 0;
    buf[62] = (len * 8) >>> 8;
    buf[63] = (len * 8) & 255;
    for (let i = 0; i < 16; i++) {
      const j = i * 4;
      w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = (w[i - 16] + (((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) + w[i - 7] +
        (((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10))) | 0;
    }
    let a = 0x6a09e667 | 0, b = 0xbb67ae85 | 0, c = 0x3c6ef372 | 0, d = 0xa54ff53a | 0;
    let e = 0x510e527f | 0, f = 0x9b05688c | 0, g = 0x1f83d9ab | 0, h = 0x5be0cd19 | 0;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) +
        ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) | 0;
      const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) +
        ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    const h0 = (0x6a09e667 + a) | 0;
    if (difficulty === 0 || h0 >>> shift === 0) return n;
  }
  return null;
}
function decryptLink(keyHex, b64) {
  const raw = atob(b64);
  const bytes = asciiBytes(raw);
  return aesCbcDecrypt(hexBytes(keyHex), bytes.subarray(0, 16), bytes.subarray(16));
}
function quoted(html, name) {
  const m = new RegExp(name + "\\s*=\\s*'([^']*)'").exec(html);
  return m ? m[1] : null;
}
function serversOf(html) {
  const data = /let\s+dataLink\s*=\s*(\[.+\]);/.exec(html);
  const challenge = quoted(html, "POW_CHALLENGE");
  const salt = quoted(html, "POW_SALT");
  const difficulty = Number((/POW_DIFFICULTY\s*=\s*(\d+)/.exec(html) || [])[1]);
  if (!data || !challenge || salt == null || !Number.isInteger(difficulty) || difficulty > MAX_DIFFICULTY) return [];
  let langs;
  try {
    langs = JSON.parse(data[1]);
  } catch (_) {
    return [];
  }
  const n = solvePow(challenge, difficulty);
  if (n == null) return [];
  const keyHex = sha256Hex(challenge + n + salt);
  const rows = [];
  for (const l of langs) {
    for (const e of (l && l.sortedEmbeds) || []) {
      if (!e || e.servername === "download" || typeof e.link !== "string") continue;
      try {
        rows.push({ lang: String(l.video_language || ""), server: String(e.servername || ""), url: decryptLink(keyHex, e.link) });
      } catch (_) {}
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Cookies (sanctum): la app no guarda cookies; se leen del set-cookie y se reenvían a mano.

function parseSetCookie(header) {
  const jar = {};
  if (!header) return jar;
  String(header).split(/,(?=\s*[A-Za-z0-9_.\-]+=)/).forEach(function (c) {
    const kv = c.split(";")[0].trim();
    const i = kv.indexOf("=");
    if (i > 0) jar[kv.slice(0, i)] = kv.slice(i + 1);
  });
  return jar;
}
function cookieHeader(jar) {
  return Object.keys(jar).map(function (k) { return k + "=" + jar[k]; }).join("; ");
}

async function playerUrl(token, pageUrl) {
  const r0 = await kfetch(SITE + "/sanctum/csrf-cookie", {
    headers: { "User-Agent": UA, Accept: "application/json", Referer: pageUrl },
    timeoutMs: 10000,
  });
  const jar = parseSetCookie(r0.headers && r0.headers.get && r0.headers.get("set-cookie"));
  const xsrf = jar["XSRF-TOKEN"];
  if (!xsrf) throw mkErr("unavailable", "no XSRF cookie");
  const r = await kfetch(SITE + "/api/player-url", {
    method: "POST",
    timeoutMs: 15000,
    body: JSON.stringify({ t: token }),
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-XSRF-TOKEN": decodeURIComponent(xsrf),
      Cookie: cookieHeader(jar),
      Referer: pageUrl,
      Origin: SITE,
    },
  });
  if (!r.ok) throw mkErr("unavailable", "player-url " + r.status);
  const j = JSON.parse(await r.text());
  return j && typeof j.url === "string" ? j.url : null;
}

// ---------------------------------------------------------------------------------------------
// Extractores

// ---- desempaquetador p.a.c.k.e.d
const ALPHA = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function toNum(s, radix) {
  let n = 0;
  for (const ch of s) n = n * radix + ALPHA.indexOf(ch);
  return n;
}
function unpack(source) {
  const m = /}\s*\(\s*'((?:\\'|[^'])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:\\'|[^'])*)'\.split\('\|'\)/.exec(source || "");
  if (!m) return null;
  const payload = m[1].replace(/\\'/g, "'");
  const radix = Number(m[2]);
  const keys = m[4].split("|");
  if (radix < 2 || radix > 62) return null;
  return payload.replace(/\b[0-9a-zA-Z]+\b/g, function (w) {
    const i = toNum(w, radix);
    return Number.isInteger(i) && i >= 0 && keys[i] ? keys[i] : w;
  });
}
function fileM3u8(txt, base) {
  const m = /\bfile\s*:\s*["']([^"']+\.m3u8[^"']*)["']/.exec(txt || "");
  return m ? absolute(m[1], base) : null;
}
function hlsKey(txt, keys, base) {
  for (const k of keys) {
    const m = new RegExp("[\"']" + k + "[\"']\\s*:\\s*[\"']([^\"']+)[\"']").exec(txt || "");
    if (m) return absolute(m[1].replace(/\\\//g, "/"), base);
  }
  return null;
}
function findIn(html, pick) {
  return pick(html) || pick(unpack(html) || "") || null;
}

async function pageText(url, headers, name) {
  const r = await kfetch(url, { headers: Object.assign({ "User-Agent": UA }, headers), timeoutMs: 9000 });
  if (!r.ok) {
    log(name, "status", r.status);
    return null;
  }
  return r.text();
}

async function exVidhide(embedUrl) {
  const origin = originOf(embedUrl);
  const html = await pageText(embedUrl, { Referer: origin + "/" }, "vidhide");
  if (html == null) return null;
  const url = findIn(html, function (t) { return hlsKey(t, ["hls4", "hls2"], origin) || fileM3u8(t, origin); });
  if (!url) return null;
  return { url: url, hls: true, headers: { Referer: origin + "/", Origin: origin } };
}

async function exStreamwish(embedUrl) {
  let u = embedUrl;
  if (hostnameOf(u) === "hglink.to") u = u.replace("hglink.to", "vibuxer.com");
  const origin = originOf(u);
  const html = await pageText(u, { Referer: origin + "/" }, "streamwish");
  if (html == null) return null;
  const url = findIn(html, function (t) { return hlsKey(t, ["hls4", "hls2", "hls3"], origin) || fileM3u8(t, origin); });
  if (!url) return null;
  return { url: url, hls: true, headers: { "User-Agent": UA, Referer: origin + "/" } };
}

const VOE_JUNK = ["@$", "^^", "~@", "%?", "*~", "!!", "#&"];
function rot13(s) {
  return s.replace(/[a-zA-Z]/g, function (c) {
    const b = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
  });
}
function decodeVoe(enc) {
  let s = rot13(enc);
  for (const j of VOE_JUNK) s = s.split(j).join("");
  s = atob(s);
  let sh = "";
  for (let i = 0; i < s.length; i++) sh += String.fromCharCode(s.charCodeAt(i) - 3);
  const bin = atob(sh.split("").reverse().join(""));
  return JSON.parse(decodeURIComponent(escape(bin)));
}
async function exVoe(embedUrl) {
  let url = embedUrl;
  for (let hop = 0; hop < 3; hop++) {
    const r = await kfetch(url, { headers: { "User-Agent": UA, Referer: embedUrl }, timeoutMs: 9000 });
    if (!r.ok) return null;
    const html = await r.text();
    if (/altcha|Confirm you(?:'|&#0?39;|’)re human/i.test(html)) return null;
    const j = /<script type="application\/json">\s*\["([^"]+)"\]/.exec(html);
    if (j) {
      try {
        const d = decodeVoe(j[1]);
        const src = d.source || d.direct_access_url;
        if (src) return { url: src, hls: !/\.mp4(?:[?#]|$)/.test(src), headers: { Referer: embedUrl } };
      } catch (_) {}
    }
    const h = /'hls'\s*:\s*'([^']+)'/.exec(html) || /(https?:\/\/[^"'\s]+\.mp4[^"'\s]*)/.exec(html);
    if (h) return { url: h[1], hls: !/\.mp4(?:[?#]|$)/.test(h[1]), headers: { Referer: embedUrl } };
    const next = /window\.location\.href\s*=\s*'([^']+)'/.exec(html);
    if (!next) return null;
    url = next[1];
  }
  return null;
}

const EXTRACTORS = [
  { name: "vidhide", hosts: ["vidhide.com", "vidhidepro.com", "vidhideplus.com", "vidhidefast.com", "dintezuvio.com", "minochinos.com", "filelions.to", "morencius.com", "callistanise.com"], run: exVidhide },
  { name: "streamwish", hosts: ["embedwish.com", "hlswish.com", "streamwish.com", "streamwish.to", "strwish.com", "wishembed.com", "filelions.com", "hglink.to", "vibuxer.com"], run: exStreamwish },
  { name: "voe", hosts: ["voe.sx"], run: exVoe },
];
function extractorFor(embedUrl) {
  const host = hostnameOf(embedUrl).replace(/^www\./, "");
  if (!host) return null;
  for (const ex of EXTRACTORS) {
    for (const h of ex.hosts) if (host === h || host.slice(-(h.length + 1)) === "." + h) return ex;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Streams

const SERVER_NAME = { vidhide: "VidHide", streamwish: "StreamWish", voe: "VOE" };
function langLabel(l) {
  const k = String(l || "").toUpperCase();
  if (k === "LAT") return "Latino";
  if (k === "CAST" || k === "ESP") return "Castellano";
  return "Subtitulado";
}
function prefLabel() {
  const v = cfg("idioma").toLowerCase();
  if (v.indexOf("cast") >= 0) return "Castellano";
  if (v.indexOf("sub") >= 0) return "Subtitulado";
  return "Latino";
}

function pageOf(p) {
  if (p.kind === "pelicula") return SITE + "/pelicula/" + p.slug;
  if (p.kind === "serie" && p.season != null && p.episode != null) {
    return SITE + "/serie/" + p.slug + "/temporada-" + p.season + "/episodio-" + p.episode;
  }
  return null;
}

async function serverRows(pageUrl) {
  const players = parsePlayers(await getPage(pageUrl, { Referer: SITE + "/" }));
  if (!players.length) return [];
  let id = null;
  for (const pl of players) {
    try {
      id = embedId(await playerUrl(pl.token, pageUrl));
    } catch (e) {
      log("player-url:", e && e.message);
      id = null;
    }
    if (id) break;
  }
  if (!id) return [];
  const r = await kfetch(EMBED_SITE + "/f/" + id, { headers: { "User-Agent": UA, Referer: SITE + "/" }, timeoutMs: 10000 });
  if (!r.ok) return [];
  const rows = serversOf(await r.text()).filter(function (s) { return s.url && extractorFor(s.url); });
  const pref = prefLabel();
  const cost = function (s) { return /vidhide/i.test(s.server) ? 1 : 0; };
  const rank = function (s) {
    const l = langLabel(s.lang);
    return (l === pref ? 0 : l === "Latino" ? 1 : l === "Castellano" ? 2 : 3) * 3 + cost(s);
  };
  return rows
    .map(function (s, i) { s.i = i; return s; })
    .sort(function (a, b) { return rank(a) - rank(b) || a.i - b.i; })
    .slice(0, MAX_COPIES);
}

async function playable(out) {
  if (!out.hls && !HLS_RE.test(out.url)) return true;
  try {
    const r = await kfetch(out.url, { headers: Object.assign({ "User-Agent": UA }, out.headers || {}), timeoutMs: 6000 });
    return r.ok || r.status === 401 || r.status === 403;
  } catch (_) {
    return false;
  }
}

// Resuelve todos en paralelo; devuelve con el primero bueno + un margen corto.
function resolveAll(jobs) {
  return new Promise(function (resolve) {
    const results = [];
    let pending = jobs.length;
    let done = false;
    let grace = false;
    function finish() {
      if (done) return;
      done = true;
      resolve(results.slice());
    }
    if (!pending) return finish();
    setTimeout(finish, RESOLVE_BUDGET_MS);
    jobs.forEach(function (job) {
      job().then(
        function (r) {
          results.push(r);
          if (!grace) {
            grace = true;
            setTimeout(finish, GRACE_MS);
          }
        },
        function () {}
      ).then(function () {
        pending--;
        if (pending === 0) finish();
      });
    });
  });
}

async function getStreams(id, type, season, episode) {
  const p = splitId(id);
  if (season != null) p.season = Number(season);
  if (episode != null) p.episode = Number(episode);
  if (p.kind === "serie" && (p.season == null || p.episode == null)) {
    const page = await titlePage("serie", p.slug);
    const first = page && page.seasons[0] && page.seasons[0].episodes[0];
    if (!first) throw mkErr("not_found", "episodio no indicado: " + id);
    p.season = first.season;
    p.episode = first.number;
  }
  const pageUrl = pageOf(p);
  if (!pageUrl) throw mkErr("not_found", "id inválido: " + id);

  const rows = await serverRows(pageUrl);
  if (!rows.length) {
    log("sin servidores compatibles en", pageUrl);
    return [];
  }
  const jobs = rows.map(function (s, idx) {
    return function () {
      const ex = extractorFor(s.url);
      return ex.run(s.url).then(function (out) {
        if (!out) throw new Error(s.server + ": sin stream");
        return playable(out).then(function (ok) {
          if (!ok) throw new Error(s.server + ": no responde");
          return {
            url: out.url,
            name: SERVER_NAME[ex.name] || s.server,
            language: langLabel(s.lang),
            provider: "SoloLatino",
            headers: Object.assign({ "User-Agent": UA }, out.headers || {}),
            isHls: !!out.hls || HLS_RE.test(out.url),
            _rank: idx,
          };
        });
      }).catch(function (e) {
        log("falló", s.server, e && e.message);
        throw e;
      });
    };
  });
  const results = await resolveAll(jobs);
  results.sort(function (a, b) { return a._rank - b._rank; });
  return results.map(function (r) { delete r._rank; return r; });
}

module.exports = {
  getHome: getHome,
  getCatalogs: getCatalogs,
  getCatalog: getCatalog,
  getDiscoverFilters: getDiscoverFilters,
  getDiscover: getDiscover,
  search: search,
  getMeta: getMeta,
  getStreams: getStreams,
};
