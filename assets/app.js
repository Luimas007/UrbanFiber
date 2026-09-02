/* ==========================================================================
   UrbanFiber storefront
   No framework. Four concerns, in order: state -> data -> render -> events.
   Backend truth lives in Supabase; this file never decides a price.
   ========================================================================== */
'use strict';

/* ---------------------------------- config -------------------------------- */
const CFG = {
  cartKey: 'uf-cart',
  themeKey: 'uf-theme',
  ribbonKey: 'uf-ribbon-seen',
  cacheKey: 'uf-catalog',
  cacheTtl: 5 * 60 * 1000,          // 5 min soft cache, revalidated in background
  maxQty: 20,
  delivery: { dhaka: 60, other: 100 }
};

const DISTRICTS = ['Bagerhat','Bandarban','Barguna','Barishal','Bhola','Bogura','Brahmanbaria','Chandpur','Chapainawabganj','Chattogram','Chuadanga',"Cox's Bazar",'Cumilla','Dhaka','Dinajpur','Faridpur','Feni','Gaibandha','Gazipur','Gopalganj','Habiganj','Jamalpur','Jashore','Jhalokati','Jhenaidah','Joypurhat','Khagrachhari','Khulna','Kishoreganj','Kurigram','Kushtia','Lakshmipur','Lalmonirhat','Madaripur','Magura','Manikganj','Meherpur','Moulvibazar','Munshiganj','Mymensingh','Naogaon','Narail','Narayanganj','Narsingdi','Natore','Netrokona','Nilphamari','Noakhali','Pabna','Panchagarh','Patuakhali','Pirojpur','Rajbari','Rajshahi','Rangamati','Rangpur','Satkhira','Shariatpur','Sherpur','Sirajganj','Sunamganj','Sylhet','Tangail','Thakurgaon'];

const COLOR_HEX = {
  black:'#111111', white:'#ffffff', 'off-white':'#f3f0e8', ash:'#a6a6a6', charcoal:'#343434',
  stone:'#8d8a80', beige:'#d7c5a8', brown:'#795548', navy:'#172554', 'royal-blue':'#2563eb',
  'sky-blue':'#38bdf8', teal:'#0f766e', olive:'#66734a', green:'#15803d', mint:'#a7f3d0',
  yellow:'#facc15', orange:'#f97316', red:'#dc2626', burgundy:'#7f1d1d', pink:'#ec4899',
  purple:'#7c3aed', lavender:'#c4b5fd'
};

/* ---------------------------------- utils --------------------------------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const money = n => '৳' + Number(n || 0).toLocaleString('en-BD', { maximumFractionDigits: 0 });

const esc = v => String(v ?? '')
  .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
  .replaceAll('"','&quot;').replaceAll("'",'&#039;');

const hexFor = c => COLOR_HEX[String(c || '').toLowerCase()] || String(c || '#888');
const titleCase = s => String(s || '').replace(/-/g, ' ').replace(/\b\w/g, m => m.toUpperCase());

/** Effective unit price. Mirrors the server rule: sale price wins when present. */
const unitPrice = p => (p?.sale_price_bdt != null ? Number(p.sale_price_bdt) : Number(p?.price_bdt || 0));
const isOnSale  = p => p?.sale_price_bdt != null && Number(p.sale_price_bdt) < Number(p.price_bdt);
const isSoldOut = p => p?.stock_status === 'sold_out';

const variantsOf = p => (p?.variants && typeof p.variants === 'object' && !Array.isArray(p.variants)) ? p.variants : {};
const sizesOf    = p => (Array.isArray(p?.sizes) && p.sizes.length) ? p.sizes : ['S','M','L','XL'];

/**
 * Images fade in via .is-ready. A cached image can already be complete before
 * any load handler is attached, so relying on `onload` alone leaves it stuck at
 * opacity 0 — an invisible product photo. Always sweep after rendering.
 */
function markReady(img) { img.classList.add('is-ready'); }
function readyImages(root = document) {
  root.querySelectorAll('img[data-fade]').forEach(img => {
    if (img.complete) markReady(img);            // cached or already decoded
    else {
      img.addEventListener('load',  () => markReady(img), { once: true });
      img.addEventListener('error', () => markReady(img), { once: true });
    }
  });
}

/* ------------------------------- supabase --------------------------------- */
const CONF = window.__UF__ || {};
let sb = null;
try {
  if (CONF.supabaseUrl && CONF.supabaseKey && window.supabase?.createClient) {
    sb = window.supabase.createClient(CONF.supabaseUrl, CONF.supabaseKey, {
      auth: { persistSession: false },          // storefront never signs anyone in
      global: { headers: { 'x-uf-client': 'storefront' } }
    });
  }
} catch (e) { console.error('Supabase init failed', e); }

/** Resolve a stored path or absolute URL into a usable image src. */
function imgUrl(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  if (sb && /^products\//i.test(s)) {
    return sb.storage.from('product-images').getPublicUrl(s).data.publicUrl || s;
  }
  return s;
}

/**
 * Product photos are admin-uploaded originals (often several MB) — the same
 * file was being shipped to a 72px cart thumbnail and a full-bleed PDP image
 * alike. Supabase Storage's image transform endpoint resizes and re-encodes
 * (WebP where supported) on the fly, so ask for only the pixels each context
 * actually needs. Falls back to the original if the URL isn't Supabase-hosted.
 */
const IMG_SIZE = {
  card: { width: 400, height: 500, quality: 70 },
  pdp:  { width: 800, height: 1000, quality: 78 },
  line: { width: 160, height: 200, quality: 65 },
  rail: { width: 880, height: 704, quality: 68 }
};
function sizedImg(url, preset) {
  const s = IMG_SIZE[preset];
  if (!s || !url) return url;
  const m = /^(.*\/storage\/v1\/)object\/(public\/.+)$/.exec(url);
  if (!m) return url;
  const params = new URLSearchParams({ quality: String(s.quality) });
  if (s.width) params.set('width', String(s.width));
  if (s.height) { params.set('height', String(s.height)); params.set('resize', 'cover'); }
  return `${m[1]}render/image/${m[2]}?${params}`;
}
const variantImg = (p, color, preset = 'card') => sizedImg(imgUrl(variantsOf(p)[color] || p?.image_url || ''), preset);

/* Warms the service worker's image cache with every product photo and size
 * chart right after the catalogue loads, so browsing later doesn't wait on
 * the network. Writes straight into Cache Storage (not just via fetch) so
 * it also works on the very first visit, before the worker has taken
 * control of the page. IMG_CACHE must match the name used in sw.js. */
const IMG_CACHE = 'uf-img-v1';
function prefetchAssets() {
  if (!('caches' in window)) return;
  const urls = new Set();
  state.products.forEach(p => {
    Object.values(variantsOf(p)).forEach(src => {
      const u = imgUrl(src);
      if (u) { urls.add(sizedImg(u, 'card')); urls.add(sizedImg(u, 'pdp')); }
    });
    const main = imgUrl(p.image_url);
    if (main) { urls.add(sizedImg(main, 'card')); urls.add(sizedImg(main, 'pdp')); }
    if (p.size_chart_url) { const u = imgUrl(p.size_chart_url); if (u) urls.add(sizedImg(u, 'pdp')); }
  });
  caches.open(IMG_CACHE).then(cache => {
    urls.forEach(u => { cache.match(u).then(hit => { if (!hit) cache.add(u).catch(() => {}); }); });
  });
}

/* --------------------------------- state ---------------------------------- */
const state = {
  products: [],
  byId: new Map(),
  settings: null,
  cart: [],
  pdp: null,          // { product, color, size, qty }
  loaded: false
};

function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CFG.cartKey) || '[]');
    state.cart = Array.isArray(raw) ? raw : [];
  } catch { state.cart = []; }
}
function saveCart() {
  try { localStorage.setItem(CFG.cartKey, JSON.stringify(state.cart)); } catch {}
  renderCart();
  renderCartCount();
}

/**
 * Reconcile the stored cart against live catalogue data.
 * Drops anything deleted/deactivated, repairs prices, keeps the user's choices
 * when they are still valid. Runs after every catalogue load.
 */
function reconcileCart() {
  if (!state.products.length) return;
  let changed = false;
  state.cart = state.cart.reduce((out, item) => {
    const p = state.byId.get(item.productId);
    if (!p || p.active === false) { changed = true; return out; }
    const vars = variantsOf(p), sizes = sizesOf(p);
    const color = vars[item.color] ? item.color : Object.keys(vars)[0];
    const size  = sizes.includes(item.size) ? item.size : sizes[0];
    if (!color) { changed = true; return out; }
    const price = unitPrice(p);
    const qty = Math.max(1, Math.min(CFG.maxQty, Number(item.quantity) || 1));
    if (color !== item.color || size !== item.size || price !== item.price || qty !== item.quantity) changed = true;
    out.push({
      productId: p.id, title: p.name, price, listPrice: Number(p.price_bdt),
      img: variantImg(p, color, 'line'), color, size, quantity: qty, soldOut: isSoldOut(p)
    });
    return out;
  }, []);
  if (changed) { try { localStorage.setItem(CFG.cartKey, JSON.stringify(state.cart)); } catch {} }
}

const cartCount = () => state.cart.reduce((n, i) => n + i.quantity, 0);
const cartTotal = () => state.cart.reduce((n, i) => n + i.price * i.quantity, 0);

/* --------------------------------- toast ---------------------------------- */
let toastTimer;
function toast(msg, tone = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.dataset.tone = tone;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 2600);
}

/* ------------------------------ data loading ------------------------------ */
function readCache() {
  try {
    const c = JSON.parse(sessionStorage.getItem(CFG.cacheKey) || 'null');
    if (c && Date.now() - c.t < CFG.cacheTtl) return c;
  } catch {}
  return null;
}
function writeCache(products, settings) {
  try { sessionStorage.setItem(CFG.cacheKey, JSON.stringify({ t: Date.now(), products, settings })); } catch {}
}

function ingest(products, settings) {
  state.products = products || [];
  state.byId = new Map(state.products.map(p => [p.id, p]));
  state.settings = settings || null;
  state.loaded = true;
  reconcileCart();
}

async function fetchCatalog() {
  if (!sb) throw new Error('Store backend is not configured.');
  const [prodRes, setRes] = await Promise.all([
    sb.from('products').select('*').eq('active', true).order('created_at', { ascending: false }),
    sb.from('site_settings').select('*').limit(1).maybeSingle()
  ]);
  if (prodRes.error) throw prodRes.error;
  // site_settings is optional: the storefront still works before the migration runs.
  const settings = setRes.error ? null : setRes.data;
  return { products: prodRes.data || [], settings };
}

async function loadCatalog({ silent = false } = {}) {
  const cached = readCache();
  if (cached) {
    ingest(cached.products, cached.settings);
    paintAll();
    silent = true;                    // we already have something on screen
  } else if (!silent) {
    paintSkeletons();
  }
  try {
    const { products, settings } = await fetchCatalog();
    ingest(products, settings);
    writeCache(products, settings);
    paintAll();
    return true;
  } catch (err) {
    console.error('Catalogue load failed', err);
    if (!cached) paintError(err?.message || 'Could not reach the store.');
    else toast('Showing saved products — refresh failed.', 'error');
    return false;
  }
}

/* -------------------------------- painting -------------------------------- */
function skeletonCards(n) {
  return Array.from({ length: n }, () => `
    <div class="card" aria-hidden="true">
      <div class="skel skel--media"></div>
      <div class="skel skel--line" style="width:70%"></div>
      <div class="skel skel--line" style="width:40%"></div>
    </div>`).join('');
}
function paintSkeletons() {
  $('#featured-track').innerHTML = skeletonCards(4);
  $('#shop-grid').innerHTML = skeletonCards(8);
}
function paintError(msg) {
  const html = `
    <div class="state state--error">
      <div class="state__icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg></div>
      <h3 style="font-size:var(--step-1)">Products could not be loaded</h3>
      <p class="muted" style="max-width:36ch">${esc(msg)}</p>
      <button class="btn btn--ghost" onclick="location.reload()">Try again</button>
    </div>`;
  $('#featured-track').innerHTML = html;
  $('#shop-grid').innerHTML = html;
}
function emptyState(title, sub, cta) {
  return `<div class="state">
    <div class="state__icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M16 11V7a4 4 0 0 0-8 0v4M5 9h14l1 12H4L5 9z"/></svg></div>
    <h3 style="font-size:var(--step-1)">${esc(title)}</h3>
    <p class="muted" style="max-width:34ch">${esc(sub)}</p>${cta || ''}</div>`;
}

function priceHtml(p, cls = '') {
  return isOnSale(p)
    ? `<div class="price price--sale ${cls}"><span class="price__now">${money(p.sale_price_bdt)}</span><s class="price__was">${money(p.price_bdt)}</s></div>`
    : `<div class="price ${cls}"><span class="price__now">${money(p.price_bdt)}</span></div>`;
}

function flagsHtml(p) {
  const f = [];
  if (isSoldOut(p)) f.push('<span class="flag flag--out">Sold out</span>');
  else {
    if (isOnSale(p)) {
      const off = Math.round((1 - p.sale_price_bdt / p.price_bdt) * 100);
      f.push(`<span class="flag flag--sale">${off}% off</span>`);
    }
    if (p.stock_status === 'low_stock') f.push('<span class="flag flag--low">Low stock</span>');
  }
  return f.length ? `<div class="card__flags">${f.join('')}</div>` : '';
}

function cardHtml(p) {
  const colors = Object.keys(variantsOf(p));
  const first = colors[0] || '';
  const src = variantImg(p, first);
  const dots = colors.length > 1 ? `<div class="dots">${colors.map((c, i) => `
      <button class="dot" style="background:${esc(hexFor(c))}" data-dot="${esc(p.id)}" data-color="${esc(c)}"
        aria-label="${esc(titleCase(c))}" aria-pressed="${i === 0}"></button>`).join('')}</div>` : '';
  return `<article class="card" data-card="${esc(p.id)}">
    <div class="card__media" data-open="${esc(p.id)}" role="button" tabindex="0" aria-label="View ${esc(p.name)}">
      ${flagsHtml(p)}
      <img src="${esc(src)}" alt="${esc(p.name)}" width="400" height="500" loading="lazy" decoding="async" data-fade>
    </div>
    <div class="card__body">
      <h3 class="card__name">${esc(p.name)}</h3>
      ${priceHtml(p)}
      ${dots}
    </div>
    <button class="btn btn--ghost card__cta" data-open="${esc(p.id)}" ${isSoldOut(p) ? 'disabled' : ''}>
      ${isSoldOut(p) ? 'Sold out' : 'Choose options'}
    </button>
  </article>`;
}

function paintFeatured() {
  const track = $('#featured-track');
  const feat = state.products.filter(p => p.is_featured);
  const list = (feat.length ? feat : state.products).slice(0, 4);
  if (!list.length) { track.innerHTML = emptyState('Nothing published yet', 'New drops are on the way.'); return; }
  track.innerHTML = list.map(cardHtml).join('');
  readyImages(track);
  $('#feat-all').style.display = window.matchMedia('(min-width:768px)').matches ? '' : 'none';
}

function paintShop() {
  const grid = $('#shop-grid');
  const cat = $('#f-cat').value;
  const sort = $('#f-sort').value;
  let list = state.products.filter(p => !cat || p.category === cat);
  const cmp = {
    asc:  (a, b) => unitPrice(a) - unitPrice(b),
    desc: (a, b) => unitPrice(b) - unitPrice(a),
    sale: (a, b) => (isOnSale(b) ? 1 : 0) - (isOnSale(a) ? 1 : 0),
    new:  (a, b) => new Date(b.created_at) - new Date(a.created_at)
  }[sort];
  list = [...list].sort(cmp);
  $('#shop-count').textContent = list.length
    ? `${list.length} ${list.length === 1 ? 'product' : 'products'}`
    : '';
  grid.innerHTML = list.length
    ? list.map(cardHtml).join('')
    : emptyState('Nothing here yet', 'Try a different category.',
        `<button class="btn btn--ghost" id="clear-filter">Clear filter</button>`);
  readyImages(grid);
}

function paintCategories() {
  const sel = $('#f-cat');
  const cats = [...new Set(state.products.map(p => p.category).filter(Boolean))].sort();
  const cur = sel.value;
  sel.innerHTML = '<option value="">All categories</option>' +
    cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (cats.includes(cur)) sel.value = cur;
}

function paintSettings() {
  const s = state.settings;
  if (!s) return;
  renderRail(Array.isArray(s.model_images) ? s.model_images.filter(Boolean) : []);
  if (s.hero_headline) $('#hero-title').textContent = s.hero_headline;
  if (s.hero_subcopy)  $('#hero-sub').textContent  = s.hero_subcopy;
  if (s.hero_cta_label) $('#hero-cta').textContent = s.hero_cta_label;

  const bar = $('#ribbon');
  const dismissed = sessionStorage.getItem(CFG.ribbonKey) === (s.ribbon_message || '');
  if (s.ribbon_enabled && s.ribbon_message && !dismissed) {
    $('#ribbon-tag').textContent = s.ribbon_label || 'News';
    const msg = $('#ribbon-msg');
    msg.textContent = s.ribbon_message;
    bar.classList.add('is-on');
    // Only animate when the text genuinely overflows.
    requestAnimationFrame(() => {
      if (msg.scrollWidth > msg.clientWidth + 4) {
        msg.classList.add('is-scrolling');
        msg.innerHTML = `<span>${esc(s.ribbon_message)}</span>`;
      }
    });
  } else {
    bar.classList.remove('is-on');
  }
}

function paintAll() {
  paintSettings();
  paintCategories();
  paintFeatured();
  paintShop();
  renderCart();
  renderCartCount();
  // Only refresh the detail view if the user is actually looking at it — a
  // background revalidation must never yank them onto another screen.
  if (state.pdp && $('#view-product').classList.contains('is-active')) {
    openProduct(state.pdp.product.id, { push: false });
  }
}

/* -------------------------------- hero -------------------------------- */
/* Two bundled slides live in the static markup (brand.jpg, brand2.jpg) and
   crossfade automatically. */
let heroTimer, heroSlides = [];
function heroStart() {
  clearInterval(heroTimer);
  heroSlides = [...$('#hero-media').querySelectorAll('.hero__img')];
  const dots = [...$('#hero-dots').children];
  if (heroSlides.length < 2) { $('#hero-dots').hidden = true; return; }
  let heroIdx = 0;
  heroTimer = setInterval(() => {
    heroSlides[heroIdx].classList.remove('is-active');
    dots[heroIdx]?.classList.remove('is-active');
    heroIdx = (heroIdx + 1) % heroSlides.length;
    heroSlides[heroIdx].classList.add('is-active');
    dots[heroIdx]?.classList.add('is-active');
  }, 5000);
}

/* -------------------------------- rail ------------------------------------ */
/* Bundled default (8 local photos) when the admin hasn't set any; otherwise
   the admin-managed list from site_settings.model_images. */
let railKey = null;
function renderRail(urls) {
  const key = JSON.stringify(urls);
  if (key === railKey) return;
  railKey = key;
  const rail = $('#rail');
  rail.innerHTML = urls.length
    ? urls.map((src, i) => `<div class="frame">
        <img src="${esc(sizedImg(src, 'rail'))}" alt="UrbanFiber model ${i + 1}" loading="lazy" decoding="async" data-fade>
      </div>`).join('')
    : Array.from({ length: 8 }, (_, i) => {
        const n = i + 1;
        return `<div class="frame">
          <picture>
            <source media="(max-width:767px)" srcset="Materials/m${n}-440.avif" type="image/avif">
            <source media="(max-width:767px)" srcset="Materials/m${n}-440.webp" type="image/webp">
            <source srcset="Materials/m${n}-880.avif" type="image/avif">
            <source srcset="Materials/m${n}-880.webp" type="image/webp">
            <img src="Materials/m${n}.jpg" alt="UrbanFiber model ${n}" width="440" height="352" loading="lazy" decoding="async" data-fade>
          </picture></div>`;
      }).join('');
  readyImages(rail);
}

let railTimer, railPaused = false;
function railStep() {
  const rail = $('#rail');
  const card = rail.querySelector('.frame');
  if (!card) return;
  const step = card.getBoundingClientRect().width + 12;
  const atEnd = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 8;
  rail.scrollTo({ left: atEnd ? 0 : rail.scrollLeft + step, behavior: 'smooth' });
}
function railNav(dir) {
  const rail = $('#rail');
  const card = rail.querySelector('.frame');
  if (!card) return;
  const step = card.getBoundingClientRect().width + 12;
  rail.scrollBy({ left: dir * step, behavior: 'smooth' });
}
function railStart() {
  clearInterval(railTimer);
  if (window.matchMedia('(prefers-reduced-motion:reduce)').matches) return;
  railTimer = setInterval(() => { if (!railPaused && !document.hidden) railStep(); }, 4200);
}

/* -------------------------------- story ----------------------------------- */
const STORY = {
  silhouette: { label:'01 / Silhouette', title:'The perfect drape', base:'Materials/specs_1',
    text:'Our signature drop-shoulder cut complements the natural lines of the body while allowing completely unrestricted movement.' },
  material: { label:'02 / Material', title:'Lycra infusion', base:'Materials/specs_2',
    text:'Heavyweight cotton bonded with premium Lycra creates a structural garment that stretches dynamically without ever losing its shape.' }
};
let storyKey = 'silhouette', storyTimer;
function setStory(key) {
  const d = STORY[key]; if (!d) return;
  storyKey = key;
  const card = $('#story-card');
  card.classList.add('is-swapping');
  setTimeout(() => {
    $('#story-pic').innerHTML =
      `<source srcset="${d.base}-640.avif" type="image/avif">
       <source srcset="${d.base}-640.webp" type="image/webp">
       <img src="${d.base}.jpg" alt="${esc(d.title)}" width="640" height="850" loading="lazy" decoding="async">`;
    $('#story-label').textContent = d.label;
    $('#story-title').textContent = d.title;
    $('#story-text').textContent  = d.text;
    $$('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.story === key)));
    card.classList.remove('is-swapping');
  }, 180);
}
function storyStart() {
  clearInterval(storyTimer);
  if (window.matchMedia('(prefers-reduced-motion:reduce)').matches) return;
  storyTimer = setInterval(() => {
    if (!document.hidden) setStory(storyKey === 'silhouette' ? 'material' : 'silhouette');
  }, 6000);
}

/* --------------------------------- router --------------------------------- */
function showView(id) {
  $$('.view').forEach(v => v.classList.toggle('is-active', v.id === `view-${id}`));
  $$('.nav a').forEach(a => {
    const on = a.dataset.nav === id;
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

function navigate(id, { push = true, scroll = true } = {}) {
  if (id === 'story') {
    showView('home');
    if (push) history.pushState({ v:'home', story:true }, '', '/?section=story');
    document.getElementById('story')?.scrollIntoView({ behavior:'smooth', block:'start' });
    return;
  }
  state.pdp = id === 'product' ? state.pdp : null;
  showView(id);
  if (push) history.pushState({ v:id }, '', id === 'shop' ? '/?shop=1' : '/');
  if (scroll) window.scrollTo({ top:0, behavior:'auto' });
}

function routeFromUrl() {
  const q = new URLSearchParams(location.search);
  if (q.get('product')) return { v:'product', slug:q.get('product') };
  if (q.get('shop') === '1') return { v:'shop' };
  if (q.get('section') === 'story') return { v:'home', story:true };
  return { v:'home' };
}

function applyRoute({ push = false } = {}) {
  const r = routeFromUrl();
  if (r.v === 'product') {
    const p = state.products.find(x => String(x.slug).toLowerCase() === String(r.slug).toLowerCase())
           || state.byId.get(r.slug);
    if (p) { openProduct(p.id, { push:false }); return; }
    if (state.loaded) { navigate('shop', { push:true }); return; }
    return;                                   // catalogue still loading; retry after
  }
  showView(r.v);
  if (r.story) setTimeout(() => document.getElementById('story')?.scrollIntoView({ block:'start' }), 60);
}

/* ------------------------------ product page ------------------------------ */
function openProduct(id, { push = true } = {}) {
  const p = state.byId.get(id);
  if (!p) { toast('That product is no longer available.', 'error'); navigate('shop'); return; }

  const colors = Object.keys(variantsOf(p));
  const keep = state.pdp?.product?.id === p.id ? state.pdp : null;
  const color = keep && colors.includes(keep.color) ? keep.color : (colors[0] || '');
  state.pdp = { product:p, color, size: keep?.size ?? null, qty: keep?.qty ?? 1 };

  $('#pdp-cat').textContent = p.category || '';
  $('#pdp-title').textContent = p.name;
  // Rewrite the inner markup only — replacing outerHTML would drop the id.
  $('#pdp-price').className = isOnSale(p) ? 'price price--sale pdp__price' : 'price pdp__price';
  $('#pdp-price').innerHTML = isOnSale(p)
    ? `<span class="price__now">${money(p.sale_price_bdt)}</span><s class="price__was">${money(p.price_bdt)}</s>`
    : `<span class="price__now">${money(p.price_bdt)}</span>`;
  $('#pdp-desc').textContent = p.description || 'Crafted from heavyweight cotton with a considered drop shoulder and a relaxed, architectural silhouette.';

  const fabricEl = $('#pdp-fabric');
  if (p.fabric_type) {
    fabricEl.innerHTML = `<b>Fabric</b><span>${esc(p.fabric_type)}</span>`;
    fabricEl.hidden = false;
  } else {
    fabricEl.hidden = true;
  }

  const stock = $('#pdp-stock');
  stock.innerHTML = isSoldOut(p)
    ? `<div class="notice" style="border-color:var(--sale);color:var(--sale)">This piece is currently sold out.</div>`
    : p.stock_status === 'low_stock'
      ? `<div class="notice" style="border-color:var(--warn)">Only a few left in stock.</div>` : '';

  // colors
  $('#pdp-colors').innerHTML = colors.map(c =>
    `<button class="swatch" data-pdp-color="${esc(c)}" style="background:${esc(hexFor(c))}"
      aria-label="${esc(titleCase(c))}" aria-pressed="${c === color}"></button>`).join('');
  $('#pdp-color-name').textContent = titleCase(color);

  // sizes
  $('#pdp-sizes').innerHTML = sizesOf(p).map(s =>
    `<button class="size" data-size="${esc(s)}" aria-pressed="${s === state.pdp.size}"
      ${isSoldOut(p) ? 'disabled' : ''}>${esc(s)}</button>`).join('');
  $('#pdp-size-err').textContent = '';

  // image
  const img = $('#pdp-img');
  img.classList.remove('is-ready');
  img.onload = () => markReady(img);
  img.onerror = () => markReady(img);
  img.src = variantImg(p, color, 'pdp');
  img.alt = p.name;
  if (img.complete) markReady(img);          // cached: onload will not fire

  $('#qty-val').textContent = state.pdp.qty;
  $('#pdp-add').disabled = isSoldOut(p);
  $('#pdp-add').textContent = isSoldOut(p) ? 'Sold out' : 'Add to cart';

  const chart = $('#pdp-chart');
  chart.style.display = p.size_chart_url ? '' : 'none';
  chart.onclick = () => openLightbox(sizedImg(imgUrl(p.size_chart_url), 'pdp'), 'Size chart');

  showView('product');
  if (push) history.pushState({ v:'product', id:p.id }, '', `/?product=${encodeURIComponent(p.slug || p.id)}`);
  window.scrollTo({ top:0, behavior:'auto' });
}

/* --------------------------------- cart ----------------------------------- */
function addToCart(product, color, size, qty) {
  if (isSoldOut(product)) { toast('That piece is sold out.', 'error'); return; }
  const price = unitPrice(product);
  const found = state.cart.find(i => i.productId === product.id && i.color === color && i.size === size);
  if (found) found.quantity = Math.min(CFG.maxQty, found.quantity + qty);
  else state.cart.push({
    productId: product.id, title: product.name, price, listPrice: Number(product.price_bdt),
    img: variantImg(product, color, 'line'), color, size, quantity: Math.min(CFG.maxQty, qty), soldOut: false
  });
  saveCart();
  toast(`${product.name} added`);
  if (navigator.vibrate) navigator.vibrate(8);
  openCart();
}

function renderCartCount() {
  const n = cartCount();
  const el = $('#cart-count');
  el.textContent = n;
  el.classList.toggle('is-on', n > 0);
  $('#cart-btn').setAttribute('aria-label', n ? `Open cart, ${n} item${n === 1 ? '' : 's'}` : 'Open cart');
}

function renderCart() {
  const body = $('#cart-body'), foot = $('#cart-foot');
  if (!state.cart.length) {
    body.innerHTML = emptyState('Your cart is empty', 'Find a silhouette you love and build your selection.',
      `<button class="btn btn--ghost" id="cart-shop">Explore pieces</button>`);
    foot.innerHTML = '';
    return;
  }
  body.innerHTML = state.cart.map((it, i) => {
    const p = state.byId.get(it.productId);
    const colors = Object.keys(variantsOf(p));
    const sizes = sizesOf(p);
    const dots = colors.length > 1 ? `<span class="line__group">
      <span class="line__label">Colour</span>
      <span class="line__dots">${colors.map(c =>
      `<button class="dot" style="background:${esc(hexFor(c))}" data-line-color="${i}" data-color="${esc(c)}"
        aria-label="${esc(titleCase(c))}" aria-pressed="${c === it.color}"></button>`).join('')}</span></span>` : '';
    // Size is editable in the cart — changing your mind should not mean
    // removing the item and starting over.
    const sizeCtl = `<span class="line__group">
      <span class="line__label" id="line-size-lbl-${i}">Size</span>
      <label class="line__size">
        <span class="sr-only">Size for ${esc(it.title)}</span>
        <select data-line-size="${i}" aria-labelledby="line-size-lbl-${i}">
          ${sizes.map(s => `<option value="${esc(s)}" ${s === it.size ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
      </label></span>`;
    const sale = it.listPrice > it.price
      ? `<s class="price__was">${money(it.listPrice)}</s>` : '';
    return `<div class="line">
      <div class="line__img"><img src="${esc(it.img)}" alt="" loading="lazy" data-fade></div>
      <div class="line__body">
        <p class="line__name">${esc(it.title)}</p>
        <div class="line__meta"><span>${money(it.price)}</span>${sale}</div>
        <div class="line__meta">${dots}${sizeCtl}</div>
        <div class="line__meta">
          <span class="line__qty">
            <button data-qty="${i}" data-d="-1" aria-label="Decrease quantity of ${esc(it.title)}">−</button>
            <output>${it.quantity}</output>
            <button data-qty="${i}" data-d="1" aria-label="Increase quantity of ${esc(it.title)}">+</button>
          </span>
        </div>
      </div>
      <button class="line__del" data-del="${i}" aria-label="Remove ${esc(it.title)}" title="Remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M9 7V4.8A1.8 1.8 0 0 1 10.8 3h2.4A1.8 1.8 0 0 1 15 4.8V7m-9 0 .8 12.2A2 2 0 0 0 8.8 21h6.4a2 2 0 0 0 2-1.8L18 7M10 11v6m4-6v6"/></svg>
      </button>
    </div>`;
  }).join('');
  readyImages(body);

  foot.innerHTML = `
    <div class="totals">
      <div class="totals__row"><span class="muted">Subtotal</span><strong>${money(cartTotal())}</strong></div>
      <div class="totals__row"><span class="muted">Delivery</span><span class="muted">Calculated at checkout</span></div>
    </div>
    <button class="btn btn--primary btn--block btn--lg" id="go-checkout">Checkout</button>`;
}

/* ------------------------------- overlays --------------------------------- */
let lastFocus = null;
function lockScroll(on) { document.body.classList.toggle('is-locked', on); }

function openCart() {
  lastFocus = document.activeElement;
  renderCart();
  $('#cart-scrim').classList.add('is-open');
  $('#cart').classList.add('is-open');
  $('#cart').setAttribute('aria-hidden', 'false');
  lockScroll(true);
  $('#cart-close').focus({ preventScroll:true });
}
function closeCart() {
  $('#cart-scrim').classList.remove('is-open');
  $('#cart').classList.remove('is-open');
  $('#cart').setAttribute('aria-hidden', 'true');
  if ($('#checkout').getAttribute('aria-hidden') !== 'false') lockScroll(false);
  lastFocus?.focus?.({ preventScroll:true });
}

/** What you're about to order — item, colour, size — so the checkout form is
 *  never a leap of faith about what you picked on the product page. */
function renderCoReview() {
  $('#co-review').innerHTML = state.cart.map(it => `
    <div class="co-review__row">
      <div class="co-review__img"><img src="${esc(it.img)}" alt=""></div>
      <div>
        <p class="co-review__name">${esc(it.title)}</p>
        <p class="co-review__meta">${esc(titleCase(it.color))} · Size ${esc(it.size)} · Qty ${it.quantity}</p>
      </div>
      <span class="co-review__amt">${money(it.price * it.quantity)}</span>
    </div>`).join('');
}

function openCheckout() {
  if (!state.cart.length) return;
  closeCart();
  $('#toast').classList.remove('is-on');   // don't let a stray "added" toast sit over the form
  renderCoReview();
  $('#co-form').hidden = false;
  $('#co-success').hidden = true;
  $('#co-err').textContent = '';
  updateTotals();
  $('#co-scrim').classList.add('is-open');
  $('#checkout').classList.add('is-open');
  $('#checkout').setAttribute('aria-hidden', 'false');
  lockScroll(true);
  setTimeout(() => $('#co-form [name=name]')?.focus({ preventScroll:true }), 320);
}
function closeCheckout() {
  $('#co-scrim').classList.remove('is-open');
  $('#checkout').classList.remove('is-open');
  $('#checkout').setAttribute('aria-hidden', 'true');
  lockScroll(false);
}

function openLightbox(src, alt) {
  const img = $('#lightbox-img');
  img.src = src;
  img.alt = alt || '';
  $('#lightbox').classList.add('is-open');
  $('#lightbox').setAttribute('aria-hidden', 'false');
  lockScroll(true);
}
function closeLightbox() {
  $('#lightbox').classList.remove('is-open');
  $('#lightbox').setAttribute('aria-hidden', 'true');
  $('#lightbox-img').src = '';
  lockScroll(false);
}

function deliveryFor(district) {
  if (!district) return null;
  const free = state.settings?.free_delivery_over_bdt;
  if (free != null && cartTotal() >= Number(free)) return 0;
  return district.toLowerCase() === 'dhaka' ? CFG.delivery.dhaka : CFG.delivery.other;
}

function updateTotals() {
  const d = $('#co-form [name=district]').value;
  const del = deliveryFor(d);
  const sub = cartTotal();
  $('#co-totals').innerHTML = `
    <div class="totals__row"><span class="muted">Subtotal</span><span>${money(sub)}</span></div>
    <div class="totals__row"><span class="muted">Delivery</span><span>${del === null ? 'Select district' : (del === 0 ? 'Free' : money(del))}</span></div>
    <div class="totals__row totals__row--grand"><span>Total</span><span>${money(sub + (del || 0))}</span></div>`;
}

/* ------------------------------- checkout --------------------------------- */
const phoneOk = v => /^01[3-9]\d{8}$/.test(String(v).replace(/^\+?88/, '').replace(/\s|-/g, ''));

function validateCheckout(fd) {
  if (!String(fd.get('name')).trim()) return 'Please enter your full name.';
  if (!phoneOk(fd.get('phone'))) return 'Enter a valid Bangladeshi mobile number, e.g. 01712345678.';
  if (!fd.get('district')) return 'Please select your district.';
  if (!String(fd.get('area')).trim()) return 'Please enter your area or thana.';
  if (String(fd.get('address')).trim().length < 10) return 'Please give a fuller delivery address.';
  const pc = String(fd.get('postcode') || '').trim();
  if (pc && !/^\d{4}$/.test(pc)) return 'Post code should be 4 digits.';
  return null;
}

async function placeOrder(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('#co-submit');
  const err = $('#co-err');
  const fd = new FormData(form);

  if (!state.cart.length) { toast('Your cart is empty', 'error'); closeCheckout(); return; }
  if (!sb) { err.textContent = 'Store backend is not configured.'; return; }

  const problem = validateCheckout(fd);
  if (problem) { err.textContent = problem; toast(problem, 'error'); return; }
  err.textContent = '';

  const payload = {
    customer: {
      name: String(fd.get('name')).trim(),
      phone: String(fd.get('phone')).replace(/\s|-/g, ''),
      district: fd.get('district'),
      area: String(fd.get('area')).trim(),
      postcode: String(fd.get('postcode') || '').trim(),
      address: String(fd.get('address')).trim()
    },
    payment_method: 'cod',
    items: state.cart.map(i => ({
      product_id: i.productId, color: i.color, size: i.size, quantity: i.quantity
    }))
  };

  btn.disabled = true; btn.textContent = 'Placing order…';
  try {
    const { data, error } = await sb.rpc('create_guest_order', { p_order: payload });
    if (error) throw error;

    // Snapshot for the invoice before the cart is cleared.
    window.__UF_INVOICE__ = {
      order: data,
      customer: payload.customer,
      items: state.cart.map(i => ({ ...i }))
    };
    state.cart = [];
    saveCart();
    form.hidden = true;
    $('#co-success').hidden = false;
    $('#co-success-msg').textContent =
      `Order ${data.order_number} received — ${money(data.total_bdt)}. We'll call to confirm your cash-on-delivery order.`;
    $('#invoice-frame').srcdoc = invoiceHtml(window.__UF_INVOICE__);
    sessionStorage.removeItem(CFG.cacheKey);   // stock may have moved
  } catch (ex) {
    console.error('Order failed', ex);
    const msg = ex?.message || 'Could not place the order. Please try again.';
    err.textContent = msg;
    toast(msg, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Place order';
  }
}

/* -------------------------------- invoice --------------------------------- */
/* invoiceHtml()/printInvoiceWindow() live in assets/invoice.js, shared with
   the admin console so both sides always render the exact same document. */
function printInvoice() {
  const result = printInvoiceWindow(invoiceHtml(window.__UF_INVOICE__));
  if (result === 'empty') toast('Invoice unavailable.', 'error');
  if (result === 'blocked') toast('Allow pop-ups to print your invoice.', 'error');
}

/* --------------------------------- theme ---------------------------------- */
const SUN = '<circle cx="12" cy="12" r="4.2" stroke-width="1.8"/><path stroke-width="1.8" d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>';
const MOON = '<path stroke-width="1.8" d="M20.4 15.4A9 9 0 0 1 8.6 3.6a9 9 0 1 0 11.8 11.8Z"/>';
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#theme-icon').innerHTML = t === 'dark' ? MOON : SUN;
  $('#theme-btn').setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'dark' ? '#121212' : '#efe9dd');
}

/* --------------------------------- events --------------------------------- */
function wire() {
  // delegated clicks
  document.addEventListener('click', e => {
    const t = e.target;

    const nav = t.closest('[data-nav]');
    if (nav) {
      e.preventDefault();
      navigate(nav.dataset.nav);
      return;
    }
    const open = t.closest('[data-open]');
    if (open && !open.disabled) { openProduct(open.dataset.open); return; }

    const dot = t.closest('[data-dot]');
    if (dot) {
      e.stopPropagation();
      const card = dot.closest('.card');
      const p = state.byId.get(dot.dataset.dot);
      if (!p || !card) return;
      $$('.dot', card).forEach(d => d.setAttribute('aria-pressed', 'false'));
      dot.setAttribute('aria-pressed', 'true');
      const img = $('img', card);
      img.classList.remove('is-ready');
      img.onload = () => markReady(img);
      img.onerror = () => markReady(img);
      img.src = variantImg(p, dot.dataset.color);
      if (img.complete) markReady(img);
      return;
    }

    const pc = t.closest('[data-pdp-color]');
    if (pc && state.pdp) {
      const c = pc.dataset.pdpColor;
      state.pdp.color = c;
      $$('#pdp-colors .swatch').forEach(s => s.setAttribute('aria-pressed', String(s === pc)));
      $('#pdp-color-name').textContent = titleCase(c);
      const img = $('#pdp-img');
      img.classList.remove('is-ready');
      img.onload = () => markReady(img);
      img.onerror = () => markReady(img);
      img.src = variantImg(state.pdp.product, c, 'pdp');
      if (img.complete) markReady(img);
      return;
    }

    const sz = t.closest('[data-size]');
    if (sz && !sz.disabled && state.pdp) {
      state.pdp.size = sz.dataset.size;
      $$('#pdp-sizes .size').forEach(b => b.setAttribute('aria-pressed', String(b === sz)));
      $('#pdp-size-err').textContent = '';
      return;
    }

    // cart line: colour swap updates the thumbnail too
    const lc = t.closest('[data-line-color]');
    if (lc) {
      const i = Number(lc.dataset.lineColor);
      const item = state.cart[i];
      const p = state.byId.get(item?.productId);
      if (!item || !p) return;
      item.color = lc.dataset.color;
      item.img = variantImg(p, item.color, 'line');
      saveCart();
      return;
    }
    const q = t.closest('[data-qty]');
    if (q) {
      const i = Number(q.dataset.qty), d = Number(q.dataset.d);
      const item = state.cart[i]; if (!item) return;
      item.quantity += d;
      if (item.quantity < 1) state.cart.splice(i, 1);
      else item.quantity = Math.min(CFG.maxQty, item.quantity);
      saveCart();
      return;
    }
    const del = t.closest('[data-del]');
    if (del) { state.cart.splice(Number(del.dataset.del), 1); saveCart(); toast('Removed'); return; }

    if (t.closest('#cart-btn'))    { openCart(); return; }
    if (t.closest('#cart-close') || t.closest('#cart-scrim')) { closeCart(); return; }
    if (t.closest('#cart-shop'))   { closeCart(); navigate('shop'); return; }
    if (t.closest('#go-checkout')) { openCheckout(); return; }
    if (t.closest('#co-close') || t.closest('#co-scrim') || t.closest('#co-continue')) { closeCheckout(); return; }
    if (t.closest('#inv-print'))    { printInvoice(); return; }
    if (t.closest('.pdp__main')) {
      const img = $('#pdp-img');
      if (img.src) openLightbox(img.src, img.alt);
      return;
    }
    if (t.closest('#lightbox-close') || t.id === 'lightbox') { closeLightbox(); return; }
    if (t.closest('#clear-filter')) { $('#f-cat').value = ''; paintShop(); return; }
    if (t.closest('#ribbon-x')) {
      $('#ribbon').classList.remove('is-on');
      try { sessionStorage.setItem(CFG.ribbonKey, state.settings?.ribbon_message || ''); } catch {}
      return;
    }
    const tab = t.closest('.tab');
    if (tab) { setStory(tab.dataset.story); storyStart(); return; }
    if (t.closest('#theme-btn')) {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem(CFG.themeKey, next); } catch {}
      return;
    }
  });

  // keyboard: cards are focusable
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      const m = e.target.closest?.('.card__media[data-open]');
      if (m) { e.preventDefault(); openProduct(m.dataset.open); }
    }
    if (e.key === 'Escape') {
      if ($('#lightbox').getAttribute('aria-hidden') === 'false') closeLightbox();
      else if ($('#checkout').getAttribute('aria-hidden') === 'false') closeCheckout();
      else if ($('#cart').getAttribute('aria-hidden') === 'false') closeCart();
    }
  });

  $('#pdp-add').addEventListener('click', () => {
    const s = state.pdp; if (!s) return;
    if (!s.size) {
      $('#pdp-size-err').textContent = 'Please choose a size.';
      toast('Choose a size first', 'error');
      $('#pdp-sizes').scrollIntoView({ behavior:'smooth', block:'center' });
      return;
    }
    addToCart(s.product, s.color, s.size, s.qty);
  });
  $('#qty-up').addEventListener('click', () => {
    if (!state.pdp) return;
    state.pdp.qty = Math.min(CFG.maxQty, state.pdp.qty + 1);
    $('#qty-val').textContent = state.pdp.qty;
  });
  $('#qty-down').addEventListener('click', () => {
    if (!state.pdp) return;
    state.pdp.qty = Math.max(1, state.pdp.qty - 1);
    $('#qty-val').textContent = state.pdp.qty;
  });

  // Size dropdowns live inside the cart, which re-renders constantly, so listen
  // on the container rather than the individual selects.
  $('#cart-body').addEventListener('change', e => {
    const sel = e.target.closest('[data-line-size]');
    if (!sel) return;
    const i = Number(sel.dataset.lineSize);
    const item = state.cart[i];
    if (!item) return;
    const next = sel.value;
    if (next === item.size) return;
    // Switching to a size already in the cart should merge, not duplicate.
    const twin = state.cart.findIndex((o, j) =>
      j !== i && o.productId === item.productId && o.color === item.color && o.size === next);
    if (twin > -1) {
      state.cart[twin].quantity = Math.min(CFG.maxQty, state.cart[twin].quantity + item.quantity);
      state.cart.splice(i, 1);
      toast(`Merged into size ${next}`);
    } else {
      item.size = next;
      toast(`Size changed to ${next}`);
    }
    saveCart();
  });

  $('#f-cat').addEventListener('change', paintShop);
  $('#f-sort').addEventListener('change', paintShop);
  $('#co-form').addEventListener('submit', placeOrder);
  $('#co-form [name=district]').addEventListener('change', updateTotals);

  // rail pause on interaction
  const rail = $('#rail'), stage = $('.stage');
  stage.addEventListener('mouseenter', () => railPaused = true);
  stage.addEventListener('mouseleave', () => railPaused = false);
  rail.addEventListener('touchstart', () => railPaused = true, { passive:true });
  rail.addEventListener('touchend',   () => { setTimeout(() => railPaused = false, 2500); }, { passive:true });
  $('#rail-prev').addEventListener('click', () => railNav(-1));
  $('#rail-next').addEventListener('click', () => railNav(1));

  // header hide on scroll down (mobile reading space)
  let lastY = 0;
  addEventListener('scroll', () => {
    const y = window.scrollY;
    $('#header').classList.toggle('is-hidden', y > lastY && y > 160);
    lastY = y;
  }, { passive:true });

  addEventListener('popstate', () => applyRoute());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) railStart(); });
}

/* ---------------------------------- boot ---------------------------------- */
function boot() {
  $('#year').textContent = new Date().getFullYear();
  applyTheme(document.documentElement.dataset.theme || 'dark');

  $('#co-form [name=district]').innerHTML =
    '<option value="">Select district</option>' +
    DISTRICTS.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');

  loadCart();
  renderRail([]);
  wire();
  heroStart();
  railStart();
  storyStart();
  renderCartCount();
  renderCart();
  applyRoute();

  loadCatalog().then(ok => { applyRoute(); if (ok) prefetchAssets(); });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
