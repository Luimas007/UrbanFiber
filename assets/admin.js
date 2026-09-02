/* ==========================================================================
   UrbanFiber admin console
   Every write goes through a SECURITY DEFINER RPC that re-checks is_admin()
   server-side. This file's auth gate is convenience, not security.
   ========================================================================== */
'use strict';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const CONF = window.__UF__ || {};
const sb = window.supabase.createClient(CONF.supabaseUrl, CONF.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true }
});

const money = n => '৳' + Number(n || 0).toLocaleString('en-BD', { maximumFractionDigits: 0 });
const esc = v => String(v ?? '')
  .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
  .replaceAll('"','&quot;').replaceAll("'",'&#039;');
const slugify = s => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
const titleCase = s => String(s||'').replace(/-/g,' ').replace(/\b\w/g,m=>m.toUpperCase());
const when = d => new Date(d).toLocaleString('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});

const PALETTE = [
  ['Black','#111111'],['White','#ffffff'],['Off White','#f3f0e8'],['Ash','#a6a6a6'],
  ['Charcoal','#343434'],['Stone','#8d8a80'],['Beige','#d7c5a8'],['Brown','#795548'],
  ['Navy','#172554'],['Royal Blue','#2563eb'],['Sky Blue','#38bdf8'],['Teal','#0f766e'],
  ['Olive','#66734a'],['Green','#15803d'],['Mint','#a7f3d0'],['Yellow','#facc15'],
  ['Orange','#f97316'],['Red','#dc2626'],['Burgundy','#7f1d1d'],['Pink','#ec4899'],
  ['Purple','#7c3aed'],['Lavender','#c4b5fd']
];
const hexFor = k => (PALETTE.find(p => slugify(p[0]) === String(k).toLowerCase()) || [null, k])[1] || '#888';

/** A message meant for the user, not a bug. Never logged to the console. */
function bad(msg) { const e = new Error(msg); e.userFacing = true; return e; }

let toastT;
function toast(msg, t = '') {
  const el = $('#toast');
  el.textContent = msg; el.dataset.t = t; el.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2800);
}

function imgUrl(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  return sb.storage.from('product-images').getPublicUrl(s).data.publicUrl || s;
}

/** Upload one file to the product-images bucket and return its public URL. */
async function upload(file, folder = 'products') {
  if (file.size > 5 * 1024 * 1024) throw new Error(`"${file.name}" is larger than 5MB. Please choose a smaller image.`);
  if (!/^image\//.test(file.type)) throw new Error(`"${file.name}" is not an image.`);
  const safe = file.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const path = `${folder}/${crypto.randomUUID()}-${safe}`;
  // Every upload gets a fresh UUID-prefixed path, so a URL is never reused —
  // safe to cache for a year; replacing an image just mints a new URL rather
  // than risking a stale cached copy of the old one.
  const { error } = await sb.storage.from('product-images')
    .upload(path, file, { contentType: file.type, upsert: false, cacheControl: '31536000' });
  if (error) throw new Error('Upload failed: ' + error.message);
  return sb.storage.from('product-images').getPublicUrl(path).data.publicUrl;
}

const state = { products: [], settings: null, tab: 'overview' };

/* --------------------------------- auth ----------------------------------- */
async function isAdmin() {
  const { data, error } = await sb.rpc('is_admin');
  if (error) { console.error(error); return false; }
  return data === true;
}

async function enterApp() {
  $('#login').style.display = 'none';
  $('#app').classList.add('on');
  await show('overview');
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget, btn = f.querySelector('button'), err = $('#login-err');
  const fd = new FormData(f);
  err.hidden = true; btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const { data, error } = await sb.auth.signInWithPassword({
      email: String(fd.get('email')).trim(), password: String(fd.get('password'))
    });
    if (error) throw error;
    if (!await isAdmin()) {
      await sb.auth.signOut();
      throw new Error('This account is not an administrator.');
    }
    await enterApp();
  } catch (ex) {
    err.textContent = ex.message || 'Sign-in failed.';
    err.hidden = false;
  } finally { btn.disabled = false; btn.textContent = 'Sign in'; }
});

$('#signout').addEventListener('click', async () => {
  await sb.auth.signOut();
  location.reload();
});

/* --------------------------------- router --------------------------------- */
$$('.tab').forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));

async function show(tab) {
  state.tab = tab;
  $$('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  const v = $('#view');
  v.innerHTML = '<div class="spin"></div>';
  try {
    if (tab === 'overview')   await viewOverview(v);
    else if (tab === 'products')  await viewProducts(v);
    else if (tab === 'orders')    await viewOrders(v, 'open');
    else if (tab === 'sales')     await viewOrders(v, 'closed');
    else if (tab === 'appearance')await viewAppearance(v);
  } catch (ex) {
    console.error(ex);
    v.innerHTML = `<div class="err-box">Could not load this section: ${esc(ex.message || 'unknown error')}</div>`;
  }
}

/* -------------------------------- overview -------------------------------- */
async function viewOverview(v) {
  const [prod, ord, pend, done] = await Promise.all([
    sb.from('products').select('*', { count:'exact', head:true }),
    sb.from('orders').select('*', { count:'exact', head:true }),
    sb.from('orders').select('*', { count:'exact', head:true }).eq('status','pending'),
    sb.from('orders').select('total_bdt').eq('status','completed')
  ]);
  const revenue = (done.data || []).reduce((n, o) => n + Number(o.total_bdt || 0), 0);
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  v.innerHTML = `
    <p class="eyebrow">Store health</p>
    <h2 style="font-size:1.7rem;margin:.3rem 0 1.2rem">${greet}</h2>
    <div class="grid g2">
      <div class="stat"><span class="eyebrow">Products</span><b>${prod.count ?? 0}</b></div>
      <div class="stat"><span class="eyebrow">Orders</span><b>${ord.count ?? 0}</b></div>
      <div class="stat"><span class="eyebrow">Awaiting action</span><b style="color:var(--warn)">${pend.count ?? 0}</b></div>
      <div class="stat"><span class="eyebrow">Completed revenue</span><b style="color:var(--ok)">${money(revenue)}</b></div>
    </div>
    <div class="card" style="margin-top:.85rem">
      <h3 style="font-size:1rem;margin-bottom:.5rem">Quick actions</h3>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <button class="btn btn--p btn--sm" data-go="products">Add a product</button>
        <button class="btn btn--g btn--sm" data-go="orders">See new orders</button>
        <button class="btn btn--g btn--sm" data-go="appearance">Edit homepage</button>
      </div>
    </div>`;
  $$('[data-go]', v).forEach(b => b.addEventListener('click', () => show(b.dataset.go)));
}

/* -------------------------------- products -------------------------------- */
async function viewProducts(v) {
  const { data, error } = await sb.from('products').select('*').order('created_at', { ascending:false });
  if (error) throw error;
  state.products = data || [];

  v.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:1rem;margin-bottom:1rem">
      <div><p class="eyebrow">Catalogue</p><h2 style="font-size:1.5rem">Products</h2></div>
      <button class="btn btn--p btn--sm" id="new-product">+ New</button>
    </div>
    ${!state.products.length ? '<div class="empty">No products yet. Tap “New” to add your first one.</div>' :
      state.products.map(p => {
        const sale = p.sale_price_bdt != null && Number(p.sale_price_bdt) < Number(p.price_bdt);
        const flags = [
          p.active ? '' : '<span class="pill pill--off">Hidden</span>',
          p.is_featured ? '<span class="pill pill--info">Featured</span>' : '',
          sale ? '<span class="pill pill--sale">On sale</span>' : '',
          p.stock_status === 'sold_out' ? '<span class="pill pill--warn">Sold out</span>' :
          p.stock_status === 'low_stock' ? '<span class="pill pill--warn">Low</span>' : ''
        ].filter(Boolean).join(' ');
        const price = sale
          ? `<span class="strike">${money(p.price_bdt)}</span> <b style="color:var(--danger)">${money(p.sale_price_bdt)}</b>`
          : `<b>${money(p.price_bdt)}</b>`;
        return `<div class="row">
          <img class="row__img" src="${esc(imgUrl(p.image_url))}" alt="" loading="lazy">
          <div class="row__b">
            <div class="row__t">${esc(p.name)}</div>
            <div class="row__m">${price} · ${esc(p.category || '')} ${flags}</div>
          </div>
          <div class="row__a">
            <button class="btn btn--g btn--sm" data-edit="${esc(p.id)}">Edit</button>
            <button class="btn btn--d btn--sm" data-del="${esc(p.id)}" data-name="${esc(p.name)}">Delete</button>
          </div>
        </div>`;
      }).join('')}`;

  $('#new-product').addEventListener('click', () => productForm(null));
  $$('[data-edit]', v).forEach(b => b.addEventListener('click',
    () => productForm(state.products.find(p => p.id === b.dataset.edit))));
  $$('[data-del]', v).forEach(b => b.addEventListener('click', () => deleteProduct(b.dataset.del, b.dataset.name)));
}

async function deleteProduct(id, name) {
  if (!confirm(`Delete “${name}”?\n\nThis cannot be undone. If the product appears in past orders it will be kept for your records instead.`)) return;
  const { error } = await sb.rpc('admin_delete_product', { p_product_id: id });
  if (error) { toast(error.message || 'Delete failed.', 'err'); return; }
  toast(`“${name}” deleted.`);
  show('products');
}

function variantRow(color = '', url = '') {
  const list = $('#variants');
  const row = document.createElement('div');
  row.className = 'vrow';
  const key = color || 'black';
  row.innerHTML = `
    <div class="vrow__top">
      <span class="sw" style="background:${esc(hexFor(key))}"></span>
      <select class="in vcolor" style="flex:1" aria-label="Colour">
        ${PALETTE.map(([n,h]) => `<option value="${slugify(n)}" data-hex="${h}" ${slugify(n)===key?'selected':''}>${n}</option>`).join('')}
      </select>
      <button type="button" class="btn btn--d btn--sm vdel" aria-label="Remove colour">Remove</button>
    </div>
    <div class="vrow__top">
      <img class="vprev" src="${esc(imgUrl(url))}" alt="" ${url ? '' : 'style="display:none"'}>
      <label class="f" style="flex:1">
        <span>Photo for this colour</span>
        <input class="in vfile" type="file" accept="image/*">
      </label>
    </div>
    <input type="hidden" class="vurl" value="${esc(url)}">`;
  list.appendChild(row);

  const sel = $('.vcolor', row), sw = $('.sw', row);
  sel.addEventListener('change', () => { sw.style.background = sel.selectedOptions[0].dataset.hex; });
  $('.vdel', row).addEventListener('click', () => {
    if ($$('.vrow').length <= 1) { toast('Keep at least one colour.', 'err'); return; }
    row.remove();
  });
  $('.vfile', row).addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    const img = $('.vprev', row);
    img.src = URL.createObjectURL(f); img.style.display = '';
  });
}

function productForm(p) {
  const v = $('#view');
  const x = p || { name:'', slug:'', category:'Oversized', price_bdt:'', sale_price_bdt:'',
    image_url:'', variants:{}, sizes:['S','M','L','XL'], active:true, is_featured:false,
    stock_status:'in_stock', description:'', fabric_type:'', size_chart_url:'' };
  const sale = x.sale_price_bdt ?? '';

  v.innerHTML = `
    <button class="btn btn--g btn--sm" id="back" style="margin-bottom:1rem">← Products</button>
    <p class="eyebrow">${p ? 'Editing' : 'New product'}</p>
    <h2 style="font-size:1.5rem;margin:.3rem 0 1.2rem">${p ? esc(p.name) : 'Add a product'}</h2>
    <form id="pform">
      <div class="card">
        <h3 style="font-size:.95rem;margin-bottom:.8rem">1 · Basics</h3>
        <div class="grid g2">
          <label class="f" style="grid-column:1/-1"><span>Product name</span>
            <input class="in" name="name" required value="${esc(x.name)}" placeholder="e.g. Urban Tee"></label>
          <label class="f"><span>Web address (slug)</span>
            <input class="in" name="slug" value="${esc(x.slug)}" placeholder="urban-tee">
            <span class="hint">Leave blank and we'll make one from the name.</span></label>
          <label class="f"><span>Category</span>
            <input class="in" name="category" value="${esc(x.category)}" placeholder="Oversized" list="cats">
            <datalist id="cats">${[...new Set(state.products.map(q=>q.category).filter(Boolean))]
              .map(c=>`<option value="${esc(c)}">`).join('')}</datalist></label>
          <label class="f"><span>Fabric — optional</span>
            <input class="in" name="fabric_type" value="${esc(x.fabric_type||'')}" placeholder="e.g. 220 GSM heavyweight cotton">
            <span class="hint">Shown on the product page when filled in.</span></label>
          <label class="f" style="grid-column:1/-1"><span>Description</span>
            <textarea class="in" name="description" placeholder="Tell customers about the fabric, fit and feel.">${esc(x.description||'')}</textarea></label>
        </div>
      </div>

      <div class="card">
        <h3 style="font-size:.95rem;margin-bottom:.3rem">2 · Price &amp; stock</h3>
        <p class="hint" style="margin-bottom:.8rem">To run a clearance, fill in the sale price. The old price is shown crossed out on the store.</p>
        <div class="grid g2">
          <label class="f"><span>Normal price (৳)</span>
            <input class="in" name="price_bdt" type="number" min="0" step="1" required value="${esc(x.price_bdt)}"></label>
          <label class="f"><span>Sale price (৳) — optional</span>
            <input class="in" name="sale_price_bdt" type="number" min="0" step="1" value="${esc(sale)}" placeholder="Leave empty for no sale">
            <span class="hint">Must be lower than the normal price.</span></label>
          <label class="f" style="grid-column:1/-1"><span>Stock</span>
            <select class="in" name="stock_status">
              <option value="in_stock"  ${x.stock_status==='in_stock'?'selected':''}>In stock</option>
              <option value="low_stock" ${x.stock_status==='low_stock'?'selected':''}>Low stock (shows a warning)</option>
              <option value="sold_out"  ${x.stock_status==='sold_out'?'selected':''}>Sold out (blocks ordering)</option>
            </select></label>
        </div>
      </div>

      <div class="card">
        <h3 style="font-size:.95rem;margin-bottom:.3rem">3 · Colours &amp; photos</h3>
        <p class="hint" style="margin-bottom:.8rem">Add one row per colour. Use the same background and lighting for every photo so customers can compare fairly.</p>
        <div id="variants"></div>
        <button type="button" class="btn btn--g btn--sm" id="add-variant" style="margin-top:.6rem">+ Add colour</button>
      </div>

      <div class="card">
        <h3 style="font-size:.95rem;margin-bottom:.8rem">4 · Sizes</h3>
        <div class="grid g3">
          ${['XS','S','M','L','XL','XXL'].map(s => `<label class="check">
            <input type="checkbox" name="size" value="${s}" ${(x.sizes||[]).includes(s)?'checked':''}>${s}</label>`).join('')}
        </div>
        <label class="f" style="margin-top:.85rem"><span>Size chart image — optional</span>
          <input class="in" type="file" id="chart-file" accept="image/*">
          ${x.size_chart_url ? `<span class="hint">A chart is already uploaded. Choosing a new file replaces it.</span>` : ''}
        </label>
        <input type="hidden" name="size_chart_url" value="${esc(x.size_chart_url||'')}">
      </div>

      <div class="card">
        <h3 style="font-size:.95rem;margin-bottom:.8rem">5 · Visibility</h3>
        <div class="grid g2">
          <label class="check"><input type="checkbox" name="active" ${x.active!==false?'checked':''}>Show on the store</label>
          <label class="check"><input type="checkbox" name="is_featured" ${x.is_featured?'checked':''}>Feature on homepage</label>
        </div>
      </div>

      <p class="err-box" id="pform-err" hidden></p>
      <div class="sticky-save">
        <button type="button" class="btn btn--g" id="cancel" style="flex:1">Cancel</button>
        <button type="submit" class="btn btn--p" style="flex:2">${p ? 'Save changes' : 'Publish product'}</button>
      </div>
    </form>`;

  const entries = Object.entries(x.variants || {});
  if (entries.length) entries.forEach(([c, u]) => variantRow(c, u));
  else variantRow('black', '');

  $('#add-variant').addEventListener('click', () => variantRow());
  $('#back').addEventListener('click', () => show('products'));
  $('#cancel').addEventListener('click', () => show('products'));
  $('#pform').addEventListener('submit', e => saveProduct(e, p));
}

async function saveProduct(e, existing) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = form.querySelector('button[type=submit]');
  const err = $('#pform-err');
  const label = btn.textContent;
  err.hidden = true; btn.disabled = true; btn.textContent = 'Saving…';

  try {
    const fd = new FormData(form);
    const name = String(fd.get('name')).trim();
    const slug = slugify(fd.get('slug') || name);
    const price = Number(fd.get('price_bdt'));
    const saleRaw = String(fd.get('sale_price_bdt') || '').trim();
    const sale = saleRaw === '' ? null : Number(saleRaw);
    const sizes = $$('input[name=size]:checked', form).map(i => i.value);

    if (!name) throw bad('Please enter a product name.');
    if (!Number.isFinite(price) || price < 0) throw bad('Please enter a valid price.');
    if (sale !== null && (!Number.isFinite(sale) || sale < 0)) throw bad('Sale price must be a number.');
    if (sale !== null && sale >= price) throw bad('The sale price must be lower than the normal price.');
    if (!sizes.length) throw bad('Please tick at least one size.');

    // colours + images
    const variants = {};
    for (const row of $$('.vrow')) {
      const color = $('.vcolor', row).value;
      let url = $('.vurl', row).value;
      const file = $('.vfile', row).files[0];
      if (file) { btn.textContent = `Uploading ${color}…`; url = await upload(file, 'products/colors'); }
      if (!url) throw bad(`Please add a photo for ${titleCase(color)}.`);
      variants[color] = url;
    }
    if (!Object.keys(variants).length) throw bad('Add at least one colour.');

    // size chart
    let chart = String(fd.get('size_chart_url') || '');
    const chartFile = $('#chart-file').files[0];
    if (chartFile) { btn.textContent = 'Uploading chart…'; chart = await upload(chartFile, 'products/charts'); }

    btn.textContent = 'Saving…';
    const payload = {
      id: existing?.id || null,
      name, slug,
      category: String(fd.get('category') || 'Oversized').trim() || 'Oversized',
      price_bdt: price,
      sale_price_bdt: sale,
      stock_status: fd.get('stock_status') || 'in_stock',
      description: String(fd.get('description') || '').trim() || null,
      fabric_type: String(fd.get('fabric_type') || '').trim() || null,
      size_chart_url: chart || null,
      image_url: Object.values(variants)[0],
      variants, sizes,
      active: fd.get('active') === 'on',
      is_featured: fd.get('is_featured') === 'on'
    };

    const { error } = await sb.rpc('admin_save_product', { p_product: payload });
    if (error) throw new Error(error.message);
    toast(existing ? 'Product updated.' : 'Product published.');
    show('products');
  } catch (ex) {
    if (!ex.userFacing) console.error(ex);
    err.textContent = ex.message || 'Could not save.';
    err.hidden = false;
    err.scrollIntoView({ behavior:'smooth', block:'center' });
    toast(ex.message || 'Could not save.', 'err');
  } finally { btn.disabled = false; btn.textContent = label; }
}

/* --------------------------------- orders --------------------------------- */
const STATUS = {
  pending:  { label:'New',       cls:'pill--warn' },
  accepted: { label:'Accepted',  cls:'pill--info' },
  shipped:  { label:'Shipped',   cls:'pill--info' },
  completed:{ label:'Completed', cls:'pill--ok'   },
  cancelled:{ label:'Cancelled', cls:'pill--off'  }
};
const NEXT = { pending:['accepted','cancelled'], accepted:['shipped','cancelled'],
  shipped:['completed','cancelled'], completed:[], cancelled:[] };

/** Forces a deliberate 3-second pause before an admin can confirm cancelling
 *  an order — cancellation can't be undone, so accidental clicks shouldn't
 *  be able to complete it instantly. */
function confirmCancel(orderNumber) {
  return new Promise(resolve => {
    const scrim = document.createElement('div');
    scrim.className = 'confirm-scrim';
    scrim.innerHTML = `
      <div class="confirm-card" role="alertdialog" aria-modal="true" aria-label="Cancel order">
        <p class="eyebrow" style="color:var(--danger)">Cancel order</p>
        <h3 style="font-size:1.15rem;margin-top:.35rem">Cancel ${esc(orderNumber)}?</h3>
        <p class="muted" style="margin-top:.5rem;font-size:.88rem;line-height:1.5">This can't be undone. Make sure the customer has already been informed before you confirm.</p>
        <div style="display:flex;gap:.6rem;margin-top:1.2rem">
          <button type="button" class="btn btn--g" id="confirm-no" style="flex:1">Keep order</button>
          <button type="button" class="btn btn--d" id="confirm-yes" style="flex:1" disabled>Cancel order (3)</button>
        </div>
      </div>`;
    document.body.appendChild(scrim);
    const yes = $('#confirm-yes', scrim), no = $('#confirm-no', scrim);
    let left = 3;
    const timer = setInterval(() => {
      left--;
      if (left <= 0) { clearInterval(timer); yes.disabled = false; yes.textContent = 'Cancel order'; }
      else yes.textContent = `Cancel order (${left})`;
    }, 1000);
    const done = v => { clearInterval(timer); scrim.remove(); resolve(v); };
    no.addEventListener('click', () => done(false));
    scrim.addEventListener('click', e => { if (e.target === scrim) done(false); });
    yes.addEventListener('click', () => done(true));
  });
}

async function viewOrders(v, mode) {
  let q = sb.from('orders').select('*,order_items(*)').order('created_at', { ascending:false });
  q = mode === 'open'
    ? q.not('status','in','(completed,cancelled)')
    : q.in('status', ['completed','cancelled']);
  const { data, error } = await q;
  if (error) throw error;
  const list = data || [];

  v.innerHTML = `
    <p class="eyebrow">${mode === 'open' ? 'Fulfilment' : 'Archive'}</p>
    <h2 style="font-size:1.5rem;margin:.3rem 0 1.2rem">${mode === 'open' ? 'Orders' : 'Sales history'}</h2>
    ${!list.length ? `<div class="empty">${mode === 'open' ? 'No open orders right now.' : 'Nothing archived yet.'}</div>` :
      list.map(o => {
        const st = STATUS[o.status] || { label:o.status, cls:'pill--off' };
        const items = (o.order_items || []).map(i =>
          `<div>${i.quantity} × ${esc(i.product_name)} <span class="muted">(${esc(titleCase(i.color))}, ${esc(i.size)})</span> — ${money(i.line_total_bdt)}</div>`).join('');
        const actions = (NEXT[o.status] || []).map(s =>
          `<button class="btn ${s==='cancelled'?'btn--d':'btn--g'} btn--sm" data-st="${esc(o.id)}" data-to="${s}">
             ${s === 'cancelled' ? 'Cancel' : 'Mark ' + s}</button>`).join('');
        return `<div class="ord">
          <div class="ord__h">
            <div>
              <div style="font-weight:600">${esc(o.order_number)} <span class="pill ${st.cls}">${st.label}</span></div>
              <div class="row__m">${when(o.created_at)}</div>
            </div>
            <div style="text-align:right"><b style="font-size:1.1rem">${money(o.total_bdt)}</b>
              <div class="row__m">${money(o.subtotal_bdt)} + ${money(o.delivery_charge_bdt)} delivery</div></div>
          </div>
          <div class="ord__items">
            <div><b style="color:var(--fg)">${esc(o.customer_name)}</b> · <a href="tel:${esc(o.phone)}" style="color:var(--info)">${esc(o.phone)}</a></div>
            <div>${esc(o.address)}, ${esc(o.area)}, ${esc(o.district)}${o.postcode ? ' — ' + esc(o.postcode) : ''}</div>
            ${items}
          </div>
          <div class="ord__a">${actions}
            <button class="btn btn--g btn--sm" data-print="${esc(o.id)}">Print slip</button>
          </div>
        </div>`;
      }).join('')}`;

  $$('[data-st]', v).forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.to === 'cancelled') {
      const ord = list.find(o => o.id === b.dataset.st);
      if (!await confirmCancel(ord ? ord.order_number : 'this order')) return;
    }
    b.disabled = true;
    const { error } = await sb.rpc('admin_set_order_status', { p_order_id: b.dataset.st, p_status: b.dataset.to });
    if (error) { toast(error.message || 'Update failed.', 'err'); b.disabled = false; return; }
    toast(`Order marked ${b.dataset.to}.`);
    show(state.tab);
  }));
  $$('[data-print]', v).forEach(b => b.addEventListener('click',
    () => printSlip(list.find(o => o.id === b.dataset.print))));
}

function printSlip(o) {
  if (!o) return;
  const rows = (o.order_items || []).map(i =>
    `<tr><td><b>${esc(i.product_name)}</b><br><small>${esc(titleCase(i.color))} / ${esc(i.size)}</small></td>
     <td style="text-align:center">${i.quantity}</td>
     <td style="text-align:right">${money(i.unit_price_bdt)}</td>
     <td style="text-align:right"><b>${money(i.line_total_bdt)}</b></td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.order_number)}</title><style>
    @page{size:A5;margin:10mm}
    body{font:13px/1.5 Helvetica,Arial,sans-serif;color:#111;margin:0;padding:18px}
    .h{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:12px}
    .b{font:700 20px Georgia,serif;letter-spacing:.16em;text-transform:uppercase}
    h1{font:400 20px Georgia,serif;margin:18px 0 4px}
    table{width:100%;border-collapse:collapse;margin:14px 0}
    th{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#888;text-align:left;
       border-bottom:1px solid #ddd;padding-bottom:6px}
    td{padding:9px 0;border-bottom:1px solid #eee;vertical-align:top}
    .tot{margin-left:auto;width:60%}
    .tot div{display:flex;justify-content:space-between;padding:4px 0}
    .g{border-top:2px solid #111;margin-top:6px;padding-top:9px;font:700 16px Georgia,serif}
    .cod{margin-top:14px;padding:10px 12px;background:#f6f4ef;border-left:3px solid #111;font-size:12px}
    @media print{body{padding:0}}
  </style></head><body>
    <div class="h"><div><div class="b">UrbanFiber</div><small>Delivery slip</small></div>
      <div style="text-align:right"><b>${esc(o.order_number)}</b><br><small>${when(o.created_at)}</small></div></div>
    <h1>${esc(o.customer_name)}</h1>
    <div>${esc(o.phone)}<br>${esc(o.address)}, ${esc(o.area)}, ${esc(o.district)}${o.postcode?' — '+esc(o.postcode):''}</div>
    <table><thead><tr><th>Item</th><th style="text-align:center">Qty</th><th style="text-align:right">Unit</th><th style="text-align:right">Total</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="tot">
      <div><span>Subtotal</span><span>${money(o.subtotal_bdt)}</span></div>
      <div><span>Delivery</span><span>${money(o.delivery_charge_bdt)}</span></div>
      <div class="g"><span>Collect</span><span>${money(o.total_bdt)}</span></div></div>
    <div class="cod"><b>Cash on delivery</b> — collect ${money(o.total_bdt)} from the customer.</div>
  </body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print.', 'err'); return; }
  w.document.write(html); w.document.close();
  w.addEventListener('load', () => setTimeout(() => w.print(), 200));
}

/* ------------------------------- appearance -------------------------------- */
async function viewAppearance(v) {
  const { data, error } = await sb.from('site_settings').select('*').limit(1).maybeSingle();
  if (error && error.code === 'PGRST205') {
    v.innerHTML = `<div class="err-box">
      <b>Setup needed.</b><br>Run <code>supabase-setup.sql</code> in your Supabase SQL Editor to enable
      homepage editing, the announcement bar and sale pricing.</div>`;
    return;
  }
  if (error) throw error;
  const s = state.settings = data || {};

  v.innerHTML = `
    <p class="eyebrow">Homepage</p>
    <h2 style="font-size:1.5rem;margin:.3rem 0 1.2rem">Hero &amp; announcements</h2>
    <form id="sform">
      <div class="card">
        <h3 style="font-size:.95rem;margin-bottom:.3rem">Announcement bar</h3>
        <p class="hint" style="margin-bottom:.8rem">A strip across the very top of the store. Use it for sales, holidays or delivery notices.</p>
        <label class="check" style="margin-bottom:.85rem">
          <input type="checkbox" name="ribbon_enabled" ${s.ribbon_enabled?'checked':''}>Show the announcement bar</label>
        <div class="grid g2">
          <label class="f"><span>Short tag</span>
            <input class="in" name="ribbon_label" maxlength="24" value="${esc(s.ribbon_label||'')}" placeholder="Sale"></label>
          <label class="f"><span>Link — optional</span>
            <input class="in" name="ribbon_href" value="${esc(s.ribbon_href||'')}" placeholder="/?shop=1"></label>
          <label class="f" style="grid-column:1/-1"><span>Message</span>
            <input class="in" name="ribbon_message" maxlength="140" value="${esc(s.ribbon_message||'')}"
              placeholder="Eid sale — up to 30% off, this week only"></label>
        </div>
      </div>

      <div class="card">
        <h3 style="font-size:.95rem;margin-bottom:.3rem">Hero</h3>
        <p class="hint" style="margin-bottom:.8rem">The homepage banner crossfades between the two bundled UrbanFiber photos automatically.</p>
        <div class="grid g2">
          <label class="f" style="grid-column:1/-1"><span>Headline</span>
            <input class="in" name="hero_headline" maxlength="60" value="${esc(s.hero_headline||'')}" placeholder="Built for the city"></label>
          <label class="f" style="grid-column:1/-1"><span>Supporting line</span>
            <textarea class="in" name="hero_subcopy" maxlength="180" placeholder="Premium oversized silhouettes…">${esc(s.hero_subcopy||'')}</textarea></label>
          <label class="f"><span>Button text</span>
            <input class="in" name="hero_cta_label" maxlength="30" value="${esc(s.hero_cta_label||'Shop the collection')}"></label>
        </div>
      </div>

      <div class="card">
        <h3 style="font-size:.95rem;margin-bottom:.3rem">"Worn in the City" photos</h3>
        <p class="hint" style="margin-bottom:.8rem">Photos shown in the auto-scrolling model rail on the homepage. Leave empty to use the default photos.</p>
        <div id="model-images"></div>
        <label class="f" style="margin-top:.6rem"><span>Add a photo</span>
          <input class="in" type="file" id="model-add" accept="image/*"></label>
      </div>

      <div class="card">
        <h3 style="font-size:.95rem;margin-bottom:.3rem">Delivery</h3>
        <label class="f"><span>Free delivery over (৳) — optional</span>
          <input class="in" name="free_delivery_over_bdt" type="number" min="0" step="1"
            value="${esc(s.free_delivery_over_bdt ?? '')}" placeholder="Leave empty to always charge">
          <span class="hint">Orders at or above this amount ship free. Normal charges are ৳60 in Dhaka, ৳100 elsewhere.</span></label>
      </div>

      <p class="err-box" id="sform-err" hidden></p>
      <div class="sticky-save">
        <button type="submit" class="btn btn--p btn--block">Save homepage</button>
      </div>
    </form>`;

  populateImageList($('#model-images'), s.model_images);
  wireImageAdd($('#model-add'), $('#model-images'), 'products/models');
  $('#sform').addEventListener('submit', saveSettings);
}

/** One removable thumbnail row, reusing the same .row markup as the product list. */
function imageRow(container, url) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.url = url;
  row.innerHTML = `
    <img class="row__img" src="${esc(imgUrl(url))}" alt="" loading="lazy">
    <div class="row__b"><div class="row__t">${esc(decodeURIComponent(url.split('/').pop() || ''))}</div></div>
    <div class="row__a"><button type="button" class="btn btn--d btn--sm" data-remove>Remove</button></div>`;
  $('[data-remove]', row).addEventListener('click', () => row.remove());
  container.appendChild(row);
}
function populateImageList(container, urls) {
  container.innerHTML = '';
  (urls || []).forEach(u => imageRow(container, u));
}
function wireImageAdd(input, container, folder) {
  input.addEventListener('change', async () => {
    const f = input.files[0]; if (!f) return;
    input.disabled = true;
    try {
      const url = await upload(f, folder);
      imageRow(container, url);
    } catch (ex) {
      toast(ex.message || 'Upload failed.', 'err');
    } finally {
      input.disabled = false;
      input.value = '';
    }
  });
}

async function saveSettings(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = form.querySelector('button[type=submit]');
  const err = $('#sform-err');
  err.hidden = true; btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const fd = new FormData(form);
    const modelImages = [...$('#model-images').children].map(r => r.dataset.url);

    const freeRaw = String(fd.get('free_delivery_over_bdt') || '').trim();
    const payload = {
      model_images: modelImages,
      hero_headline: String(fd.get('hero_headline') || '').trim(),
      hero_subcopy: String(fd.get('hero_subcopy') || '').trim(),
      hero_cta_label: String(fd.get('hero_cta_label') || '').trim(),
      ribbon_enabled: fd.get('ribbon_enabled') === 'on',
      ribbon_label: String(fd.get('ribbon_label') || '').trim(),
      ribbon_message: String(fd.get('ribbon_message') || '').trim(),
      ribbon_href: String(fd.get('ribbon_href') || '').trim(),
      free_delivery_over_bdt: freeRaw === '' ? '' : Number(freeRaw)
    };
    if (payload.ribbon_enabled && !payload.ribbon_message)
      throw bad('Add a message before switching the announcement bar on.');

    const { error } = await sb.rpc('admin_save_settings', { p_settings: payload });
    if (error) throw new Error(error.message);
    toast('Homepage updated.');
    show('appearance');
  } catch (ex) {
    err.textContent = ex.message || 'Could not save.';
    err.hidden = false;
    toast(ex.message || 'Could not save.', 'err');
  } finally { btn.disabled = false; btn.textContent = 'Save homepage'; }
}

/* ---------------------------------- boot ---------------------------------- */
(async () => {
  const { data:{ session } } = await sb.auth.getSession();
  if (session && await isAdmin()) await enterApp();
})();
