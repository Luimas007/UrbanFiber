/* ==========================================================================
   UrbanFiber invoice — shared between the storefront (assets/app.js) and
   the admin console (assets/admin.js) so a customer and an admin looking at
   the same order always see byte-identical output. Both pages load this
   file before their own script and rely on esc()/money()/titleCase(),
   which each of those already defines at the top level.
   ========================================================================== */
'use strict';

const UF_LOGO_B64 = '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';

const INVOICE_STATUS_COPY = {
  pending:   { status: 'Pending confirmation', h1: 'Thank you for your order.',
               lede: "We'll call you shortly to confirm delivery. Please keep the exact amount ready for the courier." },
  accepted:  { status: 'Confirmed — preparing', h1: 'Thank you for your order.',
               lede: 'Your order is confirmed and being prepared. Please keep the exact amount ready for the courier.' },
  shipped:   { status: 'Shipped', h1: 'Your order is on its way.',
               lede: 'Please keep the exact amount ready for the courier.' },
  completed: { status: 'Delivered', h1: 'Thank you for shopping with us.',
               lede: 'This order has been delivered.' },
  cancelled: { status: 'Cancelled', h1: 'This order was cancelled.',
               lede: 'No payment is due.' }
};

function invoiceHtml(inv) {
  if (!inv?.order) return '';
  const o = inv.order, c = inv.customer || {};
  const date = new Date(o.created_at || Date.now()).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
  const copy = INVOICE_STATUS_COPY[o.status] || INVOICE_STATUS_COPY.pending;
  const rows = inv.items.map(i => `
    <tr>
      <td><span class="nm">${esc(i.title)}</span><span class="vr">${esc(titleCase(i.color))} · Size ${esc(i.size)}</span></td>
      <td class="c">${i.quantity}</td>
      <td class="r">${money(i.price)}</td>
      <td class="r b">${money(i.price * i.quantity)}</td>
    </tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UrbanFiber Invoice ${esc(o.order_number)}</title>
<style>
  @page{size:A4;margin:14mm}
  *{box-sizing:border-box}
  body{margin:0;background:#f2efe9;color:#15120e;
    font:14px/1.55 "Helvetica Neue",Helvetica,Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sheet{width:min(860px,100% - 24px);margin:28px auto;background:#fff;padding:44px 46px;
    box-shadow:0 20px 60px rgba(0,0,0,.10)}
  .top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;
    padding-bottom:22px;border-bottom:2px solid #15120e}
  .brandmark{display:flex;align-items:center;gap:13px}
  .brandmark img{width:44px;height:44px;border-radius:50%;object-fit:cover;flex:none;
    border:1px solid #e6e0d4}
  .brand{font-family:Georgia,"Times New Roman",serif;font-size:22px;font-weight:700;
    letter-spacing:.14em;text-transform:uppercase;white-space:nowrap}
  .tag{margin-top:4px;font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:#8a8377}
  .meta{text-align:right;font-size:12px;line-height:1.75;flex:none}
  .meta .lbl{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#8a8377}
  .meta .num{font-size:15px;font-weight:700;letter-spacing:.04em}
  h1{font-family:Georgia,serif;font-weight:400;font-size:28px;margin:28px 0 6px}
  .lede{color:#6d675c;margin-bottom:26px;font-size:13px}
  .cols{display:flex;gap:34px;flex-wrap:wrap;margin-bottom:28px}
  .col{flex:1 1 210px;min-width:0}
  .col h4{margin:0 0 7px;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#8a8377;font-weight:700}
  .col p{margin:0;font-size:13px;line-height:1.7;word-break:break-word}
  table{width:100%;border-collapse:collapse;margin-bottom:22px}
  th{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#8a8377;
    text-align:left;padding:0 0 9px;border-bottom:1px solid #ddd7cb;font-weight:700}
  td{padding:13px 0;border-bottom:1px solid #eee9df;vertical-align:top}
  .c{text-align:center}.r{text-align:right}.b{font-weight:700}
  .nm{display:block;font-weight:600}
  .vr{display:block;font-size:11px;color:#8a8377;margin-top:3px;text-transform:capitalize}
  .sum{margin-left:auto;width:min(300px,100%)}
  .sum div{display:flex;justify-content:space-between;padding:7px 0;font-size:13px}
  .sum .grand{margin-top:7px;padding-top:13px;border-top:2px solid #15120e;
    font-size:19px;font-weight:700;font-family:Georgia,serif}
  .pay{margin-top:26px;padding:15px 18px;background:#f7f4ee;border-left:3px solid #15120e}
  .pay strong{display:block;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
  .pay span{font-size:12px;color:#6d675c}
  .foot{margin-top:34px;padding-top:18px;border-top:1px solid #e6e0d4;
    display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;font-size:11px;color:#8a8377}
  @media print{body{background:#fff}.sheet{box-shadow:none;margin:0;width:100%;padding:0}}
  @media(max-width:480px){
    .sheet{padding:26px 20px;margin:0}
    .top{flex-direction:column;gap:16px}
    .meta{text-align:left}
    h1{font-size:22px}
    .cols{gap:20px;margin-bottom:22px}
    table{font-size:12.5px}
    th:nth-child(3),td:nth-child(3){display:none}
  }
</style></head><body><main class="sheet">
  <div class="top">
    <div class="brandmark">
      <img src="data:image/jpeg;base64,${UF_LOGO_B64}" alt="UrbanFiber">
      <div><div class="brand">Urban Fiber</div><div class="tag">Premium oversized essentials</div></div>
    </div>
    <div class="meta"><div class="lbl">Invoice</div><div class="num">${esc(o.order_number)}</div><div>${date}</div></div>
  </div>
  <h1>${copy.h1}</h1>
  <p class="lede">${copy.lede}</p>
  <div class="cols">
    <div class="col"><h4>Deliver to</h4><p><strong>${esc(c.name)}</strong><br>${esc(c.phone)}<br>${esc(c.address)}<br>${esc(c.area)}, ${esc(c.district)}${c.postcode ? ' — ' + esc(c.postcode) : ''}</p></div>
    <div class="col"><h4>Order</h4><p>Number: <strong>${esc(o.order_number)}</strong><br>Date: ${date}<br>Status: ${esc(copy.status)}<br>Currency: BDT</p></div>
  </div>
  <table><thead><tr><th>Item</th><th class="c">Qty</th><th class="r">Unit</th><th class="r">Amount</th></tr></thead>
    <tbody>${rows}</tbody></table>
  <div class="sum">
    <div><span>Subtotal</span><span>${money(o.subtotal_bdt)}</span></div>
    <div><span>Delivery${String(c.district).toLowerCase() === 'dhaka' ? ' (inside Dhaka)' : ''}</span><span>${Number(o.delivery_charge_bdt) === 0 ? 'Free' : money(o.delivery_charge_bdt)}</span></div>
    <div class="grand"><span>Total</span><span>${money(o.total_bdt)}</span></div>
  </div>
  <div class="pay"><strong>Cash on delivery</strong><span>Pay ${money(o.total_bdt)} in cash when your order arrives.</span></div>
  <div class="foot"><span>UrbanFiber · urban-fiber.com</span><span>This invoice was generated automatically and is valid without a signature.</span></div>
</main></body></html>`;
}

/** Opens the invoice in a new tab and triggers the browser's print dialog
 *  (used for "Save as PDF" by both the customer and the admin console).
 *  Returns 'ok', 'empty' (nothing to show) or 'blocked' (pop-up blocked). */
function printInvoiceWindow(html) {
  if (!html) return 'empty';
  const w = window.open('', '_blank');
  if (!w) return 'blocked';
  w.document.write(html); w.document.close();
  w.addEventListener('load', () => setTimeout(() => w.print(), 200));
  return 'ok';
}
