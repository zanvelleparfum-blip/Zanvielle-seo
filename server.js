require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SERVER_URL = (process.env.SERVER_URL || '').replace(/\/$/, '');
const API_KEY = process.env.SHOPIER_API_KEY || '';
const API_SECRET = process.env.SHOPIER_API_SECRET || '';
const PAYMENT_URL = 'https://www.shopier.com/ShowProduct/api_pay4.php';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const ORDERS_FILE = path.join(DATA, 'orders.json');
fs.mkdirSync(DATA, { recursive: true });

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.use(express.static(PUBLIC));

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
let orders = loadJson(ORDERS_FILE, {});

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function clean(v, max = 300) { return String(v ?? '').trim().slice(0, max); }
function normalizePhone(v) { return clean(v, 30).replace(/[^0-9+]/g, ''); }
function splitName(full) {
  const parts = clean(full, 120).split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { first: parts[0] || '', last: parts[0] || '' };
  return { first: parts.shift(), last: parts.join(' ') };
}
function money(n) { return Number(n).toFixed(2); }

function loadCatalog() {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const m = html.match(/const PRODUCTS\s*=\s*(\[[\s\S]*?\]);\s*\n/);
  if (!m) throw new Error('PRODUCT_CATALOG_NOT_FOUND');
  return JSON.parse(m[1]);
}

function normalizeCheckout(rawItems, customer) {
  if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > 50) throw new Error('CHECKOUT_ITEMS_INVALID');
  const c = {
    name: clean(customer?.name, 120),
    email: clean(customer?.email, 180),
    phone: normalizePhone(customer?.phone),
    city: clean(customer?.city, 80),
    postcode: clean(customer?.postcode, 20),
    address: clean(customer?.address, 500),
  };
  if (!c.name || !c.email || !c.phone || !c.city || !c.postcode || !c.address) throw new Error('CUSTOMER_FIELDS_REQUIRED');
  if (!/^\S+@\S+\.\S+$/.test(c.email)) throw new Error('CUSTOMER_EMAIL_INVALID');
  const catalog = loadCatalog();
  const byId = new Map(catalog.map(p => [Number(p.id), p]));
  const merged = new Map();
  for (const raw of rawItems) {
    const id = Number(raw?.localId);
    const qty = Number(raw?.quantity);
    const p = byId.get(id);
    if (!p || !Number.isInteger(qty) || qty < 1 || qty > 99) throw new Error('CHECKOUT_ITEM_INVALID');
    if (Number(p.stock) <= 0) throw new Error(`OUT_OF_STOCK:${p.name}`);
    merged.set(id, (merged.get(id) || 0) + qty);
  }
  const items = [];
  for (const [id, qty] of merged) {
    const p = byId.get(id);
    if (qty > Number(p.stock)) throw new Error(`STOCK_LIMIT:${p.name}`);
    const unit = Number(p.salePrice ?? p.price);
    if (!(unit > 0)) throw new Error(`PRICE_INVALID:${p.name}`);
    items.push({
      localId: Number(p.id),
      shopierId: Number(p.shopierId || 0),
      name: String(p.name),
      quantity: qty,
      unitPrice: Number(unit.toFixed(2)),
    });
  }
  const total = Number(items.reduce((s, x) => s + x.unitPrice * x.quantity, 0).toFixed(2));
  if (!(total > 0)) throw new Error('CHECKOUT_TOTAL_INVALID');
  return { items, total, customer: c };
}

function sign(randomNr, platformOrderId, total, currency) {
  const data = `${randomNr}${platformOrderId}${total}${currency}`;
  return crypto.createHmac('sha256', API_SECRET).update(data).digest('base64');
}

function buildPaymentHtml(order) {
  const randomNr = String(crypto.randomInt(100000, 1000000));
  const orderId = order.id;
  const total = money(order.total);
  const buyer = splitName(order.customer.name);
  const productName = order.items.map(x => `${x.name} x${x.quantity}`).join(' | ').slice(0, 240);
  const fields = {
    API_key: API_KEY,
    website_index: '1',
    platform_order_id: orderId,
    product_name: productName || 'ZANVIELLE Sipariş',
    product_type: '0',
    buyer_name: buyer.first,
    buyer_surname: buyer.last,
    buyer_email: order.customer.email,
    buyer_account_age: '0',
    buyer_id_nr: orderId,
    buyer_phone: order.customer.phone,
    billing_address: order.customer.address,
    billing_city: order.customer.city,
    billing_country: 'Turkey',
    billing_postcode: order.customer.postcode,
    shipping_address: order.customer.address,
    shipping_city: order.customer.city,
    shipping_country: 'Turkey',
    shipping_postcode: order.customer.postcode,
    total_order_value: total,
    currency: '0',
    platform: '0',
    is_in_frame: '0',
    current_language: '0',
    modul_version: process.env.SHOPIER_MODULE_VERSION || '1.0.4',
    random_nr: randomNr,
    signature: sign(randomNr, orderId, total, '0'),
    callback: `${SERVER_URL}/api/shopier/callback`,
  };
  order.randomNr = randomNr;
  order.paymentCreatedAt = new Date().toISOString();
  order.status = 'payment_started';
  orders[orderId] = order;
  saveJson(ORDERS_FILE, orders);
  const inputs = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZANVIELLE Güvenli Ödeme</title></head><body><p style="font-family:Arial;text-align:center;margin-top:40px">Shopier güvenli ödeme sayfası açılıyor…</p><form id="shopier-payment" method="post" action="${PAYMENT_URL}">${inputs}</form><script>document.getElementById('shopier-payment').submit();</script></body></html>`;
}

app.get('/api/shopier/status', (req, res) => {
  res.json({
    configured: Boolean(API_KEY && API_SECRET && SERVER_URL),
    paymentGateway: PAYMENT_URL,
    mode: 'direct-payment-form',
  });
});

app.post('/api/shopier/checkout', (req, res) => {
  try {
    if (!API_KEY || !API_SECRET || !SERVER_URL) throw new Error('SHOPIER_NOT_CONFIGURED');
    const normalized = normalizeCheckout(req.body?.items, req.body?.customer);
    const orderId = `ZAN-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const order = { id: orderId, createdAt: new Date().toISOString(), status: 'pending', ...normalized };
    const checkoutHtml = buildPaymentHtml(order);
    res.json({ ok: true, orderId, checkoutHtml });
  } catch (e) {
    console.error('[checkout]', e.message);
    let status = 400;
    if (e.message === 'SHOPIER_NOT_CONFIGURED') status = 503;
    if (/^OUT_OF_STOCK|^STOCK_LIMIT/.test(e.message)) status = 409;
    res.status(status).json({ ok: false, error: e.message === 'SHOPIER_NOT_CONFIGURED' ? 'SHOPIER_NOT_CONFIGURED' : 'Ödeme bilgileri doğrulanamadı.' });
  }
});

app.post('/api/shopier/callback', (req, res) => {
  try {
    const body = req.body || {};
    const orderId = clean(body.platform_order_id, 100);
    const order = orders[orderId];
    if (!order) return res.status(404).send('Sipariş bulunamadı.');
    const randomNr = clean(body.random_nr, 30);
    const received = clean(body.signature, 500);
    const expected = sign(randomNr, orderId, money(order.total), '0');
    const valid = received && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
    if (!valid || randomNr !== order.randomNr) {
      console.warn('[callback] invalid signature', orderId);
      return res.status(400).send('Geçersiz ödeme bildirimi.');
    }
    const status = clean(body.status, 40).toLowerCase();
    order.shopierPaymentId = clean(body.payment_id, 100);
    order.shopierStatus = status;
    order.updatedAt = new Date().toISOString();
    order.status = status === 'success' ? 'paid' : 'payment_failed';
    saveJson(ORDERS_FILE, orders);
    if (status === 'success') {
      return res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial;text-align:center;padding:50px"><h1>ZANVIELLE</h1><h2>Ödemeniz alındı.</h2><p>Sipariş numaranız: <strong>${esc(orderId)}</strong></p><p><a href="/">Siteye dön</a></p></body>`);
    }
    return res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial;text-align:center;padding:50px"><h1>ZANVIELLE</h1><h2>Ödeme tamamlanamadı.</h2><p>Lütfen tekrar deneyin.</p><p><a href="/">Siteye dön</a></p></body>`);
  } catch (e) {
    console.error('[callback]', e.message);
    return res.status(500).send('Ödeme bildirimi işlenemedi.');
  }
});

app.get('/api/shopier/order/:id', (req, res) => {
  const o = orders[clean(req.params.id, 100)];
  if (!o) return res.status(404).json({ ok: false });
  res.json({ ok: true, order: { id:o.id, status:o.status, total:o.total, items:o.items, createdAt:o.createdAt, updatedAt:o.updatedAt } });
});

app.get('*', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
app.listen(PORT, () => console.log(`ZANVIELLE Shopier direct-payment server listening on :${PORT}`));
