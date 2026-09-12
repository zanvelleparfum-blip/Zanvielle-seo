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

/* =========================================================
   ZANVIELLE / SHOPIER CORS
   ========================================================= */

const ALLOWED_ORIGINS = new Set([
  'https://zanvielleparfum.com.tr',
  'https://www.zanvielleparfum.com.tr',
  'https://zanvielle-seo.onrender.com'
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET,POST,OPTIONS'
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization'
    );
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

/* =========================================================
   DOSYALAR
   ========================================================= */

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');

const ORDERS_FILE = path.join(DATA, 'orders.json');
const TOKEN_FILE = path.join(DATA, '.shopier_token.json');

fs.mkdirSync(DATA, { recursive: true });

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({
  extended: true,
  limit: '256kb'
}));
app.use(express.static(PUBLIC));

/* =========================================================
   YARDIMCI FONKSİYONLAR
   ========================================================= */

function loadJson(file, fallback) {
  try {
    return JSON.parse(
      fs.readFileSync(file, 'utf8')
    );
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  const tmp = `${file}.tmp`;

  fs.writeFileSync(
    tmp,
    JSON.stringify(value, null, 2)
  );

  fs.renameSync(tmp, file);
}

function clean(value, max = 300) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function normalizePhone(value) {
  return clean(value, 30)
    .replace(/[^0-9+]/g, '');
}

function money(value) {
  return Number(value).toFixed(2);
}

function esc(value) {
  return String(value ?? '')
    .replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[character]));
}

/* =========================================================
   VERİLER
   ========================================================= */

let orders = loadJson(
  ORDERS_FILE,
  {}
);

let tokenStore = loadJson(
  TOKEN_FILE,
  {
    access_token: '',
    refresh_token: '',
    expires_at: 0
  }
);

/* =========================================================
   TOKEN
   ========================================================= */

function saveToken(data) {
  tokenStore = {
    access_token:
      data.access_token || '',

    refresh_token:
      data.refresh_token || '',

    expires_at: data.expires_in
      ? Date.now() +
        Number(data.expires_in) * 1000 -
        60000
      : 0
  };

  saveJson(
    TOKEN_FILE,
    tokenStore
  );
}

async function tokenRequest(params) {
  const response = await fetch(
    SHOPIER_TOKEN_URL,
    {
      method: 'POST',

      headers: {
        'Content-Type':
          'application/x-www-form-urlencoded',

        'Accept':
          'application/json'
      },

      body:
        new URLSearchParams(params)
    }
  );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    const message =
      data.error_description ||
      data.error ||
      data.raw ||
      `HTTP_${response.status}`;

    throw new Error(
      `SHOPIER_TOKEN_ERROR:${message}`
    );
  }

  return data;
}

async function refreshAccessToken() {
  if (
    !CLIENT_ID ||
    !CLIENT_SECRET ||
    !tokenStore.refresh_token
  ) {
    throw new Error(
      'SHOPIER_NOT_AUTHORIZED'
    );
  }

  const data =
    await tokenRequest({
      grant_type:
        'refresh_token',

      client_id:
        CLIENT_ID,

      client_secret:
        CLIENT_SECRET,

      refresh_token:
        tokenStore.refresh_token
    });

  saveToken(data);

  return tokenStore.access_token;
}

async function getAccessToken() {
  if (
    tokenStore.access_token &&
    Date.now() <
      Number(
        tokenStore.expires_at || 0
      )
  ) {
    return tokenStore.access_token;
  }

  if (tokenStore.refresh_token) {
    try {
      return await refreshAccessToken();
    } catch (error) {
      console.warn(
        '[shopier] refresh failed:',
        error.message
      );
    }
  }

  return null;
}

/* =========================================================
   SHOPIER API
   ========================================================= */

async function shopierApi(
  method,
  endpoint,
  body = undefined
) {
  let token =
    await getAccessToken();

  if (!token) {
    throw new Error(
      'SHOPIER_NOT_AUTHORIZED'
    );
  }

  const request = async bearer => {
    const headers = {
      Authorization:
        `Bearer ${bearer}`,

      Accept:
        'application/json'
    };

    const options = {
      method,
      headers
    };

    if (body !== undefined) {
      headers['Content-Type'] =
        'application/json';

      options.body =
        JSON.stringify(body);
    }

    return fetch(
      `${SHOPIER_API}${endpoint}`,
      options
    );
  };

  let response =
    await request(token);

  if (
    response.status === 401 &&
    tokenStore.refresh_token
  ) {
    token =
      await refreshAccessToken();

    response =
      await request(token);
  }

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    console.error(
      '[shopier api]',
      method,
      endpoint,
      response.status,
      data
    );

    throw new Error(
      `SHOPIER_API_ERROR:${response.status}`
    );
  }

  return data;
}

/* =========================================================
   ÜRÜN KATALOĞU
   ========================================================= */

function loadCatalog() {
  const indexPath =
    path.join(
      PUBLIC,
      'index.html'
    );

  if (!fs.existsSync(indexPath)) {
    throw new Error(
      'INDEX_HTML_NOT_FOUND'
    );
  }

  const html =
    fs.readFileSync(
      indexPath,
      'utf8'
    );

  const match =
    html.match(
      /const PRODUCTS\s*=\s*(\[[\s\S]*?\]);\s*\n/
    );

  if (!match) {
    throw new Error(
      'PRODUCT_CATALOG_NOT_FOUND'
    );
  }

  return JSON.parse(
    match[1]
  );
}

/* =========================================================
   CHECKOUT VERİSİ
   ========================================================= */

function normalizeCheckout(
  rawItems,
  customer
) {
  if (
    !Array.isArray(rawItems) ||
    !rawItems.length ||
    rawItems.length > 50
  ) {
    throw new Error(
      'CHECKOUT_ITEMS_INVALID'
    );
  }

  const c = {
    name:
      clean(
        customer?.name,
        120
      ),

    email:
      clean(
        customer?.email,
        180
      ),

    phone:
      normalizePhone(
        customer?.phone
      ),

    city:
      clean(
        customer?.city,
        80
      ),

    postcode:
      clean(
        customer?.postcode,
        20
      ),

    address:
      clean(
        customer?.address,
        500
      )
  };

  if (
    !c.name ||
    !c.email ||
    !c.phone ||
    !c.city ||
    !c.postcode ||
    !c.address
  ) {
    throw new Error(
      'CUSTOMER_FIELDS_REQUIRED'
    );
  }

  if (
    !/^\S+@\S+\.\S+$/.test(
      c.email
    )
  ) {
    throw new Error(
      'CUSTOMER_EMAIL_INVALID'
    );
  }

  const catalog =
    loadCatalog();

  const byId =
    new Map(
      catalog.map(product => [
        Number(product.id),
        product
      ])
    );

  const merged =
    new Map();

  for (const raw of rawItems) {
    const id =
      Number(raw?.localId);

    const quantity =
      Number(raw?.quantity);

    const product =
      byId.get(id);

    if (
      !product ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 99
    ) {
      throw new Error(
        'CHECKOUT_ITEM_INVALID'
      );
    }

    if (
      Number(product.stock) <= 0
    ) {
      throw new Error(
        `OUT_OF_STOCK:${product.name}`
      );
    }

    merged.set(
      id,
      (merged.get(id) || 0) +
        quantity
    );
  }

  const items = [];

  for (
    const [id, quantity]
    of merged
  ) {
    const product =
      byId.get(id);

    if (
      quantity >
      Number(product.stock)
    ) {
      throw new Error(
        `STOCK_LIMIT:${product.name}`
      );
    }

    const unitPrice =
      Number(
        product.salePrice ??
        product.price
      );

    if (!(unitPrice > 0)) {
      throw new Error(
        `PRICE_INVALID:${product.name}`
      );
    }

    items.push({
      localId:
        Number(product.id),

      shopierId:
        Number(
          product.shopierId || 0
        ),

      name:
        String(product.name),

      quantity,

      unitPrice:
        Number(
          unitPrice.toFixed(2)
        )
    });
  }

  const total =
    Number(
      items
        .reduce(
          (sum, item) =>
            sum +
            item.unitPrice *
            item.quantity,
          0
        )
        .toFixed(2)
    );

  if (!(total > 0)) {
    throw new Error(
      'CHECKOUT_TOTAL_INVALID'
    );
  }

  return {
    items,
    total,
    customer: c
  };
}

/* =========================================================
   SHOPIER HOSTED CHECKOUT
   ========================================================= */

function buildHostedCheckoutHtml(
  productId,
  quantity = 1
) {
  if (!SHOP_SLUG) {
    throw new Error(
      'SHOPIER_SHOP_SLUG_REQUIRED'
    );
  }

  const pid =
    esc(productId);

  const slug =
    esc(SHOP_SLUG);

  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZANVIELLE Güvenli Ödeme</title>
</head>

<body>

<p style="font-family:Arial;text-align:center;margin-top:40px">
Shopier güvenli ödeme sayfası açılıyor…
</p>

<form
  id="shopier-hosted-checkout"
  method="POST"
  action="https://www.shopier.com/s/shipping/${slug}"
>

<input
  type="hidden"
  name="product_id"
  value="${pid}"
>

<input
  type="hidden"
  name="quantity"
  value="${Number(quantity) || 1}"
>

</form>

<script>
document
  .getElementById('shopier-hosted-checkout')
  .submit();
</script>

</body>
</html>`;
}

/* =========================================================
   SHOPIER DURUM
   ========================================================= */

app.get(
  '/api/shopier/status',
  async (req, res) => {
    try {
      const token =
        await getAccessToken();

      res.json({
        configured:
          Boolean(
            CLIENT_ID &&
            CLIENT_SECRET &&
            SERVER_URL
          ),

        authorized:
          Boolean(token),

        shopSlugConfigured:
          Boolean(SHOP_SLUG),

        redirectUri:
          REDIRECT_URI,

        mode:
          'oauth-hosted-checkout'
      });
    } catch (error) {
      res.status(500).json({
        configured: false,
        authorized: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   SHOPIER BAĞLANTI
   ========================================================= */

app.get(
  '/api/shopier/connect',
  (req, res) => {
    if (
      !CLIENT_ID ||
      !CLIENT_SECRET ||
      !SERVER_URL
    ) {
      return res
        .status(503)
        .send(
          'Shopier OAuth ayarları eksik.'
        );
    }

    const state =
      crypto
        .randomBytes(24)
        .toString('hex');

    saveJson(
      path.join(
        DATA,
        '.oauth_state.json'
      ),
      {
        state,
        createdAt:
          Date.now()
      }
    );

    const params =
      new URLSearchParams({
        response_type:
          'code',

        client_id:
          CLIENT_ID,

        redirect_uri:
          REDIRECT_URI,

        state
      });

    res.redirect(
      `${SHOPIER_AUTH_URL}?${params.toString()}`
    );
  }
);

/* =========================================================
   SHOPIER CALLBACK
   ========================================================= */

app.get(
  '/api/shopier/callback',
  async (req, res) => {
    const {
      code,
      state,
      error,
      error_description
    } = req.query;

    if (error) {
      return res
        .status(400)
        .send(
          `Shopier bağlantısı reddedildi: ${esc(
            error_description ||
            error
          )}`
        );
    }

    if (!code) {
      return res
        .status(400)
        .send(
          'Shopier authorization code alınamadı.'
        );
    }

    const savedState =
      loadJson(
        path.join(
          DATA,
          '.oauth_state.json'
        ),
        {}
      );

    if (
      !state ||
      state !== savedState.state ||
      Date.now() -
        Number(
          savedState.createdAt || 0
        ) >
        10 * 60 * 1000
    ) {
      return res
        .status(400)
        .send(
          'Geçersiz veya süresi dolmuş OAuth state.'
        );
    }

    try {
      const data =
        await tokenRequest({
          grant_type:
            'authorization_code',

          client_id:
            CLIENT_ID,

          client_secret:
            CLIENT_SECRET,

          code:
            String(code),

          redirect_uri:
            REDIRECT_URI
        });

      saveToken(data);

      res.send(`
<!doctype html>
<html lang="tr">

<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZANVIELLE</title>
</head>

<body style="font-family:Arial;text-align:center;padding:50px">

<h1>ZANVIELLE</h1>

<h2 style="color:#16834b">
Shopier bağlantısı başarılı.
</h2>

<p>
Şimdi ödeme altyapısını test edebiliriz.
</p>

<p>
<a href="/">
Siteye dön
</a>
</p>

</body>
</html>
`);
    } catch (error) {
      console.error(
        '[oauth callback]',
        error.message
      );

      res
        .status(500)
        .send(`
<pre style="white-space:pre-wrap;font-family:Arial;padding:30px">
Shopier OAuth bağlantısı başarısız.

${esc(error.message)}
</pre>
`);
    }
  }
);

/* =========================================================
   SHOPIER CHECKOUT
   ========================================================= */

app.post(
  '/api/shopier/checkout',
  async (req, res) => {
    try {
      if (
        !CLIENT_ID ||
        !CLIENT_SECRET ||
        !SERVER_URL
      ) {
        throw new Error(
          'SHOPIER_NOT_CONFIGURED'
        );
      }

      const token =
        await getAccessToken();

      if (!token) {
        throw new Error(
          'SHOPIER_NOT_AUTHORIZED'
        );
      }

      if (!SHOP_SLUG) {
        throw new Error(
          'SHOPIER_SHOP_SLUG_REQUIRED'
        );
      }

      const normalized =
        normalizeCheckout(
          req.body?.items,
          req.body?.customer
        );

      const orderId =
        `ZAN-${Date.now()}-${crypto
          .randomBytes(4)
          .toString('hex')
          .toUpperCase()}`;

      const productName =
        normalized.items
          .map(
            item =>
              `${item.name} x${item.quantity}`
          )
          .join(' | ')
          .slice(0, 180);

      const productPayload = {
        title:
          `ZANVIELLE Sipariş ${orderId}`,

        description:
          `${productName}\n` +
          `Müşteri: ${normalized.customer.name}\n` +
          `E-posta: ${normalized.customer.email}\n` +
          `Telefon: ${normalized.customer.phone}\n` +
          `Adres: ${normalized.customer.address}, ${normalized.customer.city} ${normalized.customer.postcode}`,

        type:
          'physical',

        priceData: {
          currency:
            'TRY',

          price:
            money(
              normalized.total
            )
        },

        stockQuantity:
          1,

        shippingPayer:
          'sellerPays',

        customListing:
          true
      };

      const product =
        await shopierApi(
          'POST',
          '/products',
          productPayload
        );

      const productId =
        String(
          product.id || ''
        );

      if (!productId) {
        throw new Error(
          'SHOPIER_PRODUCT_ID_MISSING'
        );
      }

      orders[orderId] = {
        id:
          orderId,

        createdAt:
          new Date().toISOString(),

        status:
          'checkout_created',

        shopierProductId:
          productId,

        total:
          normalized.total,

        items:
          normalized.items,

        customer:
          normalized.customer
      };

      saveJson(
        ORDERS_FILE,
        orders
      );

      const checkoutHtml =
        buildHostedCheckoutHtml(
          productId,
          1
        );

      res.json({
        ok:
          true,

        orderId,

        checkoutHtml
      });

    } catch (error) {
      console.error(
        '[checkout]',
        error.message
      );

      let status = 400;

      if (
        [
          'SHOPIER_NOT_CONFIGURED',
          'SHOPIER_NOT_AUTHORIZED',
          'SHOPIER_SHOP_SLUG_REQUIRED'
        ].includes(
          error.message
        )
      ) {
        status = 503;
      }

      if (
        /^OUT_OF_STOCK|^STOCK_LIMIT/.test(
          error.message
        )
      ) {
        status = 409;
      }

      res
        .status(status)
        .json({
          ok:
            false,

          error:
            error.message
        });
    }
  }
);

/* =========================================================
   SİPARİŞ SORGULAMA
   ========================================================= */

app.get(
  '/api/shopier/order/:id',
  (req, res) => {
    const order =
      orders[
        clean(
          req.params.id,
          100
        )
      ];

    if (!order) {
      return res
        .status(404)
        .json({
          ok:
            false
        });
    }

    res.json({
      ok:
        true,

      order: {
        id:
          order.id,

        status:
          order.status,

        total:
          order.total,

        items:
          order.items,

        shopierProductId:
          order.shopierProductId,

        createdAt:
          order.createdAt
      }
    });
  }
);

/* =========================================================
   ANA SAYFA
   ========================================================= */

app.get(
  '*',
  (req, res) => {
    res.sendFile(
      path.join(
        PUBLIC,
        'index.html'
      )
    );
  }
);

/* =========================================================
   SERVER
   ========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `ZANVIELLE Shopier OAuth server listening on :${PORT}`
    );
  }
);
