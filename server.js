require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const SERVER_URL = String(process.env.SERVER_URL || "").replace(/\/$/, "");

const CLIENT_ID = process.env.SHOPIER_CLIENT_ID || "";
const CLIENT_SECRET = process.env.SHOPIER_CLIENT_SECRET || "";
const SHOP_SLUG = process.env.SHOPIER_SHOP_SLUG || "";

const SHOPIER_API = "https://api.shopier.com/v1";
const SHOPIER_TOKEN_URL = "https://api.shopier.com:8443/v1/oauth2/token";
const SHOPIER_AUTH_URL = "https://shopier.com/m/login.php";

const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, "index.html");
const DATA_DIR = path.join(ROOT, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const TOKEN_FILE = path.join(DATA_DIR, ".shopier_token.json");
const STATE_FILE = path.join(DATA_DIR, ".oauth_state.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function money(value) {
  return Number(value).toFixed(2);
}

let orders = readJson(ORDERS_FILE, {});

let tokenStore = readJson(TOKEN_FILE, {
  access_token: "",
  refresh_token: "",
  expires_at: 0
});


/* =========================
   CORS
========================= */

app.use((req, res, next) => {
  const origin = req.headers.origin;

  const allowed = [
    "https://zanvielleparfum.com.tr",
    "https://www.zanvielleparfum.com.tr",
    "https://zanvielle-seo.onrender.com"
  ];

  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "2mb" }));

app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb"
  })
);


/* =========================
   ÜRÜN KATALOĞU
========================= */

function loadCatalog() {
  if (!fs.existsSync(INDEX_FILE)) {
    throw new Error("INDEX_HTML_NOT_FOUND");
  }

  const html = fs.readFileSync(INDEX_FILE, "utf8");

  const match = html.match(
    /const\s+PRODUCTS\s*=\s*(\[[\s\S]*?\]);/
  );

  if (!match) {
    throw new Error("PRODUCT_CATALOG_NOT_FOUND");
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    throw new Error("PRODUCT_CATALOG_INVALID");
  }
}


/* =========================
   SHOPIER TOKEN
========================= */

function saveToken(data) {
  tokenStore = {
    access_token: data.access_token || "",
    refresh_token:
      data.refresh_token ||
      tokenStore.refresh_token ||
      "",
    expires_at: data.expires_in
      ? Date.now() +
        Number(data.expires_in) * 1000 -
        60000
      : tokenStore.expires_at || 0
  };

  writeJson(TOKEN_FILE, tokenStore);
}

async function tokenRequest(body) {
  const response = await fetch(
    SHOPIER_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: new URLSearchParams(body)
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      "SHOPIER_TOKEN_ERROR:" +
        (
          data.error_description ||
          data.error ||
          data.raw ||
          response.status
        )
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
    throw new Error("SHOPIER_NOT_AUTHORIZED");
  }

  const data = await tokenRequest({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: tokenStore.refresh_token
  });

  saveToken(data);

  return tokenStore.access_token;
}

async function getAccessToken() {
  if (
    tokenStore.access_token &&
    Date.now() <
      Number(tokenStore.expires_at || 0)
  ) {
    return tokenStore.access_token;
  }

  if (tokenStore.refresh_token) {
    try {
      return await refreshAccessToken();
    } catch (error) {
      console.error(
        "[TOKEN REFRESH]",
        error.message
      );
    }
  }

  return null;
}


/* =========================
   SHOPIER API
========================= */

async function shopierApi(
  method,
  endpoint,
  body
) {
  let accessToken = await getAccessToken();

  if (!accessToken) {
    throw new Error("SHOPIER_NOT_AUTHORIZED");
  }

  async function request(token) {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    };

    const options = {
      method,
      headers
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    return fetch(
      SHOPIER_API + endpoint,
      options
    );
  }

  let response = await request(accessToken);

  if (
    response.status === 401 &&
    tokenStore.refresh_token
  ) {
    accessToken = await refreshAccessToken();
    response = await request(accessToken);
  }

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    console.error(
      "[SHOPIER API]",
      response.status,
      data
    );

    throw new Error(
      "SHOPIER_API_ERROR:" +
        response.status
    );
  }

  return data;
}


/* =========================
   SEPET
========================= */

function normalizeCheckout(rawItems) {
  if (
    !Array.isArray(rawItems) ||
    rawItems.length === 0 ||
    rawItems.length > 50
  ) {
    throw new Error(
      "CHECKOUT_ITEMS_INVALID"
    );
  }

  const catalog = loadCatalog();

  const byLocalId = new Map();
  const byShopierId = new Map();

  for (const product of catalog) {
    const localId = Number(product.id);

    if (Number.isFinite(localId)) {
      byLocalId.set(localId, product);
    }

    const shopierId = Number(
      product.shopierId
    );

    if (
      Number.isFinite(shopierId) &&
      shopierId > 0
    ) {
      byShopierId.set(
        shopierId,
        product
      );
    }
  }

  const items = [];

  for (const raw of rawItems) {
    const id = Number(
      raw?.productId ??
      raw?.localId ??
      raw?.shopierId ??
      raw?.id
    );

    const quantity = Number(
      raw?.quantity || 1
    );

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 99
    ) {
      throw new Error(
        "CHECKOUT_QUANTITY_INVALID"
      );
    }

    let product =
      byShopierId.get(id) ||
      byLocalId.get(id);

    if (!product && raw?.name) {
      const wanted = String(
        raw.name
      )
        .trim()
        .toLowerCase();

      product = catalog.find(
        p =>
          String(p.name || "")
            .toLowerCase() === wanted
      );
    }

    if (!product) {
      throw new Error(
        "PRODUCT_NOT_FOUND"
      );
    }

    const price = Number(
      product.salePrice ??
      product.price
    );

    if (!(price > 0)) {
      throw new Error(
        "PRICE_INVALID:" +
          product.name
      );
    }

    const stock = Number(
      product.stock
    );

    if (
      Number.isFinite(stock) &&
      stock < quantity
    ) {
      throw new Error(
        "STOCK_LIMIT:" +
          product.name
      );
    }

    items.push({
      localId: Number(product.id),
      shopierId: Number(
        product.shopierId || 0
      ),
      name: String(product.name),
      quantity,
      unitPrice: Number(
        price.toFixed(2)
      )
    });
  }

  const total = Number(
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
      "CHECKOUT_TOTAL_INVALID"
    );
  }

  return {
    items,
    total
  };
}


/* =========================
   HOSTED CHECKOUT
========================= */

function buildCheckoutHtml(
  productId,
  quantity = 1
) {
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">
<title>ZANVIELLE Güvenli Ödeme</title>
</head>

<body style="
margin:0;
background:#f7f3eb;
font-family:Arial,sans-serif;
display:flex;
align-items:center;
justify-content:center;
min-height:100vh;
">

<div style="
text-align:center;
padding:40px;
">

<h1>ZANVIELLE</h1>

<p>
Güvenli ödeme sayfasına
yönlendiriliyorsunuz...
</p>

<form
id="zanvielleShopierForm"
method="POST"
action="https://www.shopier.com/s/shipping/${SHOP_SLUG}"
>

<input
type="hidden"
name="product_id"
value="${String(productId).replace(
    /"/g,
    "&quot;"
  )}"
>

<input
type="hidden"
name="quantity"
value="${quantity}"
>

</form>

<script>
document
.getElementById(
  "zanvielleShopierForm"
)
.submit();
</script>

</div>

</body>
</html>`;
}


/* =========================
   HEALTH
========================= */

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "ZANVIELLE Shopier",
      time:
        new Date().toISOString()
    });
  }
);


/* =========================
   SHOPIER STATUS
========================= */

app.get(
  "/api/shopier/status",
  async (req, res) => {
    try {
      res.json({
        ok: true,
        configured:
          !!(
            CLIENT_ID &&
            CLIENT_SECRET &&
            SERVER_URL
          ),
        authorized:
          !!(await getAccessToken()),
        shopSlugConfigured:
          !!SHOP_SLUG,
        serverUrl:
          SERVER_URL
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);


/* =========================
   SHOPIER CONNECT
========================= */

app.get(
  "/api/shopier/connect",
  (req, res) => {
    if (
      !CLIENT_ID ||
      !CLIENT_SECRET ||
      !SERVER_URL
    ) {
      return res
        .status(503)
        .send(
          "Shopier OAuth ayarları eksik."
        );
    }

    const state =
      crypto.randomBytes(24).toString(
        "hex"
      );

    writeJson(
      STATE_FILE,
      {
        state,
        createdAt: Date.now()
      }
    );

    const url =
      new URL(SHOPIER_AUTH_URL);

    url.searchParams.set(
      "response_type",
      "code"
    );

    url.searchParams.set(
      "client_id",
      CLIENT_ID
    );

    url.searchParams.set(
      "redirect_uri",
      `${SERVER_URL}/api/shopier/callback`
    );

    url.searchParams.set(
      "state",
      state
    );

    res.redirect(
      url.toString()
    );
  }
);


/* =========================
   SHOPIER CALLBACK
========================= */

app.get(
  "/api/shopier/callback",
  async (req, res) => {
    try {
      if (req.query.error) {
        return res
          .status(400)
          .send(
            "Shopier bağlantısı reddedildi."
          );
      }

      const savedState =
        readJson(
          STATE_FILE,
          {}
        );

      if (
        !req.query.code ||
        req.query.state !==
          savedState.state ||
        Date.now() -
          Number(
            savedState.createdAt || 0
          ) >
          600000
      ) {
        return res
          .status(400)
          .send(
            "Geçersiz veya süresi dolmuş bağlantı."
          );
      }

      const data =
        await tokenRequest({
          grant_type:
            "authorization_code",
          client_id:
            CLIENT_ID,
          client_secret:
            CLIENT_SECRET,
          code:
            String(req.query.code),
          redirect_uri:
            `${SERVER_URL}/api/shopier/callback`
        });

      saveToken(data);

      res.send(`
<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<title>ZANVIELLE</title>
</head>
<body style="
font-family:Arial;
text-align:center;
padding:60px 20px;
">
<h1>ZANVIELLE</h1>
<h2>Shopier bağlantısı başarılı.</h2>
<p>Ödeme sistemi hazır.</p>
<a href="/">Siteye dön</a>
</body>
</html>
`);
    } catch (error) {
      console.error(
        "[CALLBACK ERROR]",
        error
      );

      res
        .status(500)
        .send(
          "Shopier bağlantı hatası: " +
            clean(
              error.message,
              500
            )
        );
    }
  }
);


/* =========================
   CHECKOUT
========================= */

app.post(
  "/api/shopier/checkout",
  async (req, res) => {
    try {
      console.log(
        "[CHECKOUT REQUEST]",
        JSON.stringify(
          req.body
        )
      );

      if (
        !CLIENT_ID ||
        !CLIENT_SECRET
      ) {
        throw new Error(
          "SHOPIER_NOT_CONFIGURED"
        );
      }

      if (!SHOP_SLUG) {
        throw new Error(
          "SHOPIER_SHOP_SLUG_REQUIRED"
        );
      }

      if (!(await getAccessToken())) {
        throw new Error(
          "SHOPIER_NOT_AUTHORIZED"
        );
      }

      const normalized =
        normalizeCheckout(
          req.body?.items
        );

      const orderId =
        "ZAN-" +
        Date.now() +
        "-" +
        crypto
          .randomBytes(3)
          .toString("hex")
          .toUpperCase();

      const productName =
        normalized.items
          .map(
            item =>
              `${item.name} x${item.quantity}`
          )
          .join(" | ")
          .slice(0, 180);

      const productPayload = {
        title:
          `ZANVIELLE Sipariş ${orderId}`,

        description:
          productName,

        type:
          "physical",

        priceData: {
          currency:
            "TRY",

          price:
            money(
              normalized.total
            )
        },

        shippingPayer:
          "sellerPays"
      };

      console.log(
        "[SHOPIER PRODUCT REQUEST]",
        JSON.stringify(
          productPayload
        )
      );

      const product =
        await shopierApi(
          "POST",
          "/products",
          productPayload
        );

      console.log(
        "[SHOPIER PRODUCT RESPONSE]",
        JSON.stringify(
          product
        )
      );

      const productId =
        String(
          product?.id ||
          product?.product?.id ||
          ""
        );

      if (!productId) {
        throw new Error(
          "SHOPIER_PRODUCT_ID_MISSING"
        );
      }

      orders[orderId] = {
        id:
          orderId,

        createdAt:
          new Date().toISOString(),

        status:
          "checkout_created",

        shopierProductId:
          productId,

        total:
          normalized.total,

        items:
          normalized.items
      };

      writeJson(
        ORDERS_FILE,
        orders
      );

      const checkoutHtml =
        buildCheckoutHtml(
          productId,
          1
        );

      console.log(
        "[CHECKOUT SUCCESS]",
        orderId
      );

      res.json({
        ok: true,
        orderId,
        checkoutHtml
      });

    } catch (error) {
      console.error(
        "[CHECKOUT ERROR]",
        error
      );

      const status =
        [
          "SHOPIER_NOT_CONFIGURED",
          "SHOPIER_NOT_AUTHORIZED",
          "SHOPIER_SHOP_SLUG_REQUIRED"
        ].includes(
          error.message
        )
          ? 503
          : 400;

      res
        .status(status)
        .json({
          ok: false,
          error:
            error.message
        });
    }
  }
);


/* =========================
   ORDER
========================= */

app.get(
  "/api/shopier/order/:id",
  (req, res) => {
    const id =
      clean(
        req.params.id,
        100
      );

    const order =
      orders[id];

    if (!order) {
      return res
        .status(404)
        .json({
          ok: false,
          error:
            "ORDER_NOT_FOUND"
        });
    }

    res.json({
      ok: true,
      order
    });
  }
);


/* =========================
   SITE
========================= */

app.get(
  ["/", "/index.html"],
  (req, res) => {
    if (
      !fs.existsSync(
        INDEX_FILE
      )
    ) {
      return res
        .status(500)
        .send(
          "index.html bulunamadı."
        );
    }

    res.sendFile(
      INDEX_FILE
    );
  }
);

app.use(
  express.static(
    ROOT
  )
);


/* =========================
   404
========================= */

app.use(
  (req, res) => {
    res
      .status(404)
      .json({
        ok: false,
        error:
          "NOT_FOUND"
      });
  }
);


/* =========================
   SERVER
========================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "================================"
    );

    console.log(
      "ZANVIELLE SHOPIER SERVER"
    );

    console.log(
      "PORT:",
      PORT
    );

    console.log(
      "SERVER_URL:",
      SERVER_URL ||
        "(eksik)"
    );

    console.log(
      "SHOPIER CLIENT:",
      CLIENT_ID
        ? "OK"
        : "EKSİK"
    );

    console.log(
      "SHOPIER SECRET:",
      CLIENT_SECRET
        ? "OK"
        : "EKSİK"
    );

    console.log(
      "SHOP SLUG:",
      SHOP_SLUG
        ? "OK"
        : "EKSİK"
    );

    console.log(
      "================================"
    );
  }
);
