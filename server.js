require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SERVER_URL = (process.env.SERVER_URL || '').replace(/\/$/, '');
const CLIENT_ID = process.env.SHOPIER_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SHOPIER_CLIENT_SECRET || '';
const SHOP_SLUG = process.env.SHOPIER_SHOP_SLUG || '';

const SHOPIER_API = 'https://api.shopier.com/v1';
const SHOPIER_TOKEN_URL = 'https://api.shopier.com:8443/v1/oauth2/token';
const SHOPIER_AUTH_URL = 'https://shopier.com/m/login.php';
const REDIRECT_URI = `${SERVER_URL}/api/shopier/callback`;

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const ORDERS_FILE = path.join(DATA, 'orders.json');
const TOKEN_FILE = path.join(DATA, '.shopier_token.json');
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
function clean(v, max = 300) { return String(v ?? '').trim().slice(0, max); }
function normalizePhone(v) { return clean(v, 30).replace(/[^0-9+]/g, ''); }
function money(n) { return Number(n).toFixed(2); }
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

let orders = loadJson(ORDERS_FILE, {});
let tokenStore = loadJson(TOKEN_FILE, { access_token: '', refresh_token: '', expires_at: 0 });

function saveToken(data) {
  tokenStore = {
    access_token: data.access_token || '',
    refresh_token: data.refresh_token || '',
    expires_at: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 - 60000 : 0,
  };
  saveJson(TOKEN_FILE, tokenStore);
}

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

async function tokenRequest(params) {
  const response = await fetch(SHOPIER_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams(params),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    const msg = data.error_description || data.error || data.raw || `HTTP_${response.status}`;
    throw new Error(`SHOPIER_TOKEN_ERROR:${msg}`);
  }
  return data;
}

async function refreshAccessToken() {
  if (!CLIENT_ID || !CLIENT_SECRET || !tokenStore.refresh_token) throw new Error('SHOPIER_NOT_AUTHORIZED');
  const data = await tokenRequest({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: tokenStore.refresh_token,
  });
  saveToken(data);
  return tokenStore.access_token;
}

async function getAccessToken() {
  if (tokenStore.access_token && Date.now() < Number(tokenStore.expires_at || 0)) return tokenStore.access_token;
  if (tokenStore.refresh_token) {
    try { return await refreshAccessToken(); } catch (e) { console.warn('[shopier] refresh failed:', e.message); }
  }
  return null;
}

async function shopierApi(method, endpoint, body = undefined) {
  let token = await getAccessToken();
  if (!token) throw new Error('SHOPIER_NOT_AUTHORIZED');

  const request = async (bearer) => {
    const headers = { Authorization: `Bearer ${bearer}`, Accept: 'application/json' };
    const options = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch(`${SHOPIER_API}${endpoint}`, options);
  };

  let response = await request(token);
  if (response.status === 401 && tokenStore.refresh_token) {
    token = await refreshAccessToken();
    response = await request(token);
  }

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    console.error('[shopier api]', method, endpoint, response.status, data);
    throw new Error(`SHOPIER_API_ERROR:${response.status}`);
  }
  return data;
}

function buildHostedCheckoutHtml(productId, quantity = 1) {
  if (!SHOP_SLUG) throw new Error('SHOPIER_SHOP_SLUG_REQUIRED');
  const pid = esc(productId);
  const slug = esc(SHOP_SLUG);
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZANVIELLE Güvenli Ödeme</title></head><body><p style="font-family:Arial;text-align:center;margin-top:40px">Shopier güvenli ödeme sayfası açılıyor…</p><form id="shopier-hosted-checkout" method="POST" action="https://www.shopier.com/s/shipping/${slug}"><input type="hidden" name="product_id" value="${pid}"><input type="hidden" name="quantity" value="${Number(quantity) || 1}"></form><script>document.getElementById('shopier-hosted-checkout').submit();</script></body></html>`;
}

app.get('/api/shopier/status', async (req, res) => {
  const token = await getAccessToken();
  res.json({
    configured: Boolean(CLIENT_ID && CLIENT_SECRET && SERVER_URL),
    authorized: Boolean(token),
    shopSlugConfigured: Boolean(SHOP_SLUG),
    redirectUri: REDIRECT_URI,
    mode: 'oauth-hosted-checkout',
  });
});

app.get('/api/shopier/connect', (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET || !SERVER_URL) return res.status(503).send('Shopier OAuth ayarları eksik.');
  const state = crypto.randomBytes(24).toString('hex');
  saveJson(path.join(DATA, '.oauth_state.json'), { state, createdAt: Date.now() });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state,
  });
  res.redirect(`${SHOPIER_AUTH_URL}?${params.toString()}`);
});

app.get('/api/shopier/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.status(400).send(`Shopier bağlantısı reddedildi: ${esc(error_description || error)}`);
  if (!code) return res.status(400).send('Shopier authorization code alınamadı.');

  const savedState = loadJson(path.join(DATA, '.oauth_state.json'), {});
  if (!state || state !== savedState.state || Date.now() - Number(savedState.createdAt || 0) > 10 * 60 * 1000) {
    return res.status(400).send('Geçersiz veya süresi dolmuş OAuth state.');
  }

  try {
    const data = await tokenRequest({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: String(code),
      redirect_uri: REDIRECT_URI,
    });
    saveToken(data);
    res.send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial;text-align:center;padding:50px"><h1>ZANVIELLE</h1><h2 style="color:#16834b">Shopier bağlantısı başarılı.</h2><p>Şimdi ödeme altyapısını test edebiliriz.</p><p><a href="/">Siteye dön</a></p></body>');
  } catch (e) {
    console.error('[oauth callback]', e.message);
    res.status(500).send(`<pre style="white-space:pre-wrap;font-family:Arial;padding:30px">Shopier OAuth bağlantısı başarısız.\n\n${esc(e.message)}</pre>`);
  }
});

app.post('/api/shopier/checkout', async (req, res) => {
  try {
    if (!CLIENT_ID || !CLIENT_SECRET || !SERVER_URL) throw new Error('SHOPIER_NOT_CONFIGURED');
    const token = await getAccessToken();
    if (!token) throw new Error('SHOPIER_NOT_AUTHORIZED');
    if (!SHOP_SLUG) throw new Error('SHOPIER_SHOP_SLUG_REQUIRED');

    const normalized = normalizeCheckout(req.body?.items, req.body?.customer);
    const orderId = `ZAN-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const productName = normalized.items.map(x => `${x.name} x${x.quantity}`).join(' | ').slice(0, 180);
    const imageUrl = normalized.items.find(x => x.shopierId)?.shopierId ? undefined : undefined;

    const productPayload = {
      title: `ZANVIELLE Sipariş ${orderId}`,
      description: `${productName}\nMüşteri: ${normalized.customer.name}\nE-posta: ${normalized.customer.email}\nTelefon: ${normalized.customer.phone}\nAdres: ${normalized.customer.address}, ${normalized.customer.city} ${normalized.customer.postcode}`,
      type: 'physical',
      priceData: { currency: 'TRY', price: money(normalized.total) },
      stockQuantity: 1,
      shippingPayer: 'sellerPays',
      customListing: true,
    };

    const product = await shopierApi('POST', '/products', productPayload);
    const productId = String(product.id || '');
    if (!productId) throw new Error('SHOPIER_PRODUCT_ID_MISSING');

    orders[orderId] = {
      id: orderId,
      createdAt: new Date().toISOString(),
      status: 'checkout_created',
      shopierProductId: productId,
      total: normalized.total,
      items: normalized.items,
      customer: normalized.customer,
    };
    saveJson(ORDERS_FILE, orders);

    const checkoutHtml = buildHostedCheckoutHtml(productId, 1);
    res.json({ ok: true, orderId, checkoutHtml });
  } catch (e) {
    console.error('[checkout]', e.message);
    let status = 400;
    if (['SHOPIER_NOT_CONFIGURED', 'SHOPIER_NOT_AUTHORIZED', 'SHOPIER_SHOP_SLUG_REQUIRED'].includes(e.message)) status = 503;
    if (/^OUT_OF_STOCK|^STOCK_LIMIT/.test(e.message)) status = 409;
    res.status(status).json({ ok: false, error: e.message });
  }
});

app.get('/api/shopier/order/:id', (req, res) => {
  const o = orders[clean(req.params.id, 100)];
  if (!o) return res.status(404).json({ ok: false });
  res.json({ ok: true, order: { id:o.id, status:o.status, total:o.total, items:o.items, shopierProductId:o.shopierProductId, createdAt:o.createdAt } });
});

app.get('*', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
app.listen(PORT, () => console.log(`ZANVIELLE Shopier OAuth server listening on :${PORT}`));
