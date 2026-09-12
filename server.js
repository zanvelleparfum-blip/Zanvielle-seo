require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 3000);

const SERVER_URL = String(
  process.env.SERVER_URL || ""
).replace(/\/+$/, "");

const CLIENT_ID =
  process.env.SHOPIER_CLIENT_ID || "";

const CLIENT_SECRET =
  process.env.SHOPIER_CLIENT_SECRET || "";

const SHOP_SLUG =
  process.env.SHOPIER_SHOP_SLUG || "";

const SHOPIER_API =
  "https://api.shopier.com/v1";

const SHOPIER_TOKEN_URL =
  "https://api.shopier.com:8443/v1/oauth2/token";

const SHOPIER_AUTH_URL =
  "https://shopier.com/m/login.php";

const ROOT = __dirname;

const INDEX_FILE =
  path.join(ROOT, "index.html");

const DATA_DIR =
  path.join(ROOT, "data");

const ORDERS_FILE =
  path.join(DATA_DIR, "orders.json");

const TOKEN_FILE =
  path.join(DATA_DIR, ".shopier_token.json");

const OAUTH_STATE_FILE =
  path.join(DATA_DIR, ".oauth_state.json");


/* =========================================================
   KLASÖR
   ========================================================= */

fs.mkdirSync(DATA_DIR, {
  recursive: true
});


/* =========================================================
   CORS
   ========================================================= */

const ALLOWED_ORIGINS = new Set([
  "https://zanvielleparfum.com.tr",
  "https://www.zanvielleparfum.com.tr",
  "https://zanvilleparfum.com.tr",
  "https://www.zanvilleparfum.com.tr",
  "https://zanvielle-seo.onrender.com",
  "https://zanvelleparfum-blip.github.io"
]);

app.use((req, res, next) => {

  const origin =
    req.headers.origin;

  if (
    origin &&
    ALLOWED_ORIGINS.has(origin)
  ) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin
    );

    res.setHeader(
      "Vary",
      "Origin"
    );
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});


/* =========================================================
   BODY
   ========================================================= */

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb"
  })
);


/* =========================================================
   JSON
   ========================================================= */

function loadJson(file, fallback) {

  try {

    if (!fs.existsSync(file)) {
      return fallback;
    }

    const text =
      fs.readFileSync(
        file,
        "utf8"
      );

    if (!text.trim()) {
      return fallback;
    }

    return JSON.parse(text);

  } catch (error) {

    console.error(
      "[JSON READ ERROR]",
      error.message
    );

    return fallback;
  }
}


function saveJson(file, value) {

  const temp =
    `${file}.tmp`;

  fs.writeFileSync(
    temp,
    JSON.stringify(
      value,
      null,
      2
    ),
    "utf8"
  );

  fs.renameSync(
    temp,
    file
  );
}


let orders =
  loadJson(
    ORDERS_FILE,
    {}
  );


let tokenStore =
  loadJson(
    TOKEN_FILE,
    {
      access_token: "",
      refresh_token: "",
      expires_at: 0
    }
  );


/* =========================================================
   YARDIMCILAR
   ========================================================= */

function clean(value, max = 500) {

  return String(
    value ?? ""
  )
    .trim()
    .slice(0, max);
}


function money(value) {

  return Number(
    value
  ).toFixed(2);
}


function escapeHtml(value) {

  return String(
    value ?? ""
  ).replace(
    /[&<>"']/g,
    char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char])
  );
}


/* =========================================================
   ÜRÜN KATALOĞU
   ========================================================= */

function loadCatalog() {

  if (
    !fs.existsSync(
      INDEX_FILE
    )
  ) {
    throw new Error(
      "INDEX_HTML_NOT_FOUND"
    );
  }

  const html =
    fs.readFileSync(
      INDEX_FILE,
      "utf8"
    );

  const match =
    html.match(
      /const\s+PRODUCTS\s*=\s*(\[[\s\S]*?\]);/
    );

  if (!match) {

    throw new Error(
      "PRODUCT_CATALOG_NOT_FOUND"
    );
  }

  try {

    return JSON.parse(
      match[1]
    );

  } catch (error) {

    console.error(
      "[PRODUCT CATALOG ERROR]",
      error.message
    );

    throw new Error(
      "PRODUCT_CATALOG_INVALID"
    );
  }
}


/* =========================================================
   SHOPIER TOKEN
   ========================================================= */

function saveToken(data) {

  tokenStore = {

    access_token:
      data.access_token || "",

    refresh_token:
      data.refresh_token ||
      tokenStore.refresh_token ||
      "",

    expires_at:
      data.expires_in
        ? Date.now() +
          Number(data.expires_in) *
          1000 -
          60000
        : tokenStore.expires_at || 0
  };

  saveJson(
    TOKEN_FILE,
    tokenStore
  );
}


async function tokenRequest(params) {

  const response =
    await fetch(
      SHOPIER_TOKEN_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",

          "Accept":
            "application/json"
        },

        body:
          new URLSearchParams(
            params
          )
      }
    );

  const text =
    await response.text();

  let data;

  try {

    data =
      JSON.parse(text);

  } catch {

    data = {
      raw: text
    };
  }

  if (!response.ok) {

    throw new Error(
      "SHOPIER_TOKEN_ERROR:" +
      (
        data.error_description ||
        data.error ||
        data.raw ||
        `HTTP_${response.status}`
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

    throw new Error(
      "SHOPIER_NOT_AUTHORIZED"
    );
  }

  const data =
    await tokenRequest({

      grant_type:
        "refresh_token",

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

  if (
    tokenStore.refresh_token
  ) {

    try {

      return await
        refreshAccessToken();

    } catch (error) {

      console.warn(
        "[TOKEN REFRESH]",
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
  body
) {

  let token =
    await getAccessToken();

  if (!token) {

    throw new Error(
      "SHOPIER_NOT_AUTHORIZED"
    );
  }


  async function request(
    bearer
  ) {

    const headers = {

      "Authorization":
        `Bearer ${bearer}`,

      "Accept":
        "application/json"

    };

    const options = {
      method,
      headers
    };

    if (
      body !== undefined
    ) {

      headers[
        "Content-Type"
      ] =
        "application/json";

      options.body =
        JSON.stringify(body);
    }

    return fetch(
      `${SHOPIER_API}${endpoint}`,
      options
    );
  }


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

    data =
      JSON.parse(text);

  } catch {

    data = {
      raw: text
    };
  }


  if (!response.ok) {

    console.error(
      "[SHOPIER API ERROR]",
      response.status,
      JSON.stringify(
        data
      )
    );

    throw new Error(
      `SHOPIER_API_ERROR:${response.status}:${JSON.stringify(data)}`
    );
  }

  return data;
}


/* =========================================================
   SEPETİ HAZIRLA
   ========================================================= */

function normalizeCheckout(
  rawItems
) {

  if (
    !Array.isArray(rawItems) ||
    rawItems.length === 0
  ) {

    throw new Error(
      "CHECKOUT_ITEMS_INVALID"
    );
  }


  const catalog =
    loadCatalog();


  /*
   * Hem yerel ürün ID'sini
   * hem Shopier ID'sini kabul ediyoruz.
   */

  const byLocalId =
    new Map();

  const byShopierId =
    new Map();


  for (
    const product of catalog
  ) {

    const localId =
      Number(product.id);

    if (
      Number.isFinite(localId)
    ) {

      byLocalId.set(
        localId,
        product
      );
    }


    const shopierId =
      Number(
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


  for (
    const raw of rawItems
  ) {

    const receivedId =
      Number(
        raw?.productId ??
        raw?.localId ??
        raw?.id
      );


    const quantity =
      Number(
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
      byShopierId.get(
        receivedId
      );


    if (!product) {

      product =
        byLocalId.get(
          receivedId
        );
    }


    /*
     * Frontend'den ürün ID'si gelmezse,
     * isim ile de son bir eşleştirme yapıyoruz.
     */

    if (!product && raw?.name) {

      const wanted =
        clean(
          raw.name,
          200
        ).toLowerCase();

      product =
        catalog.find(
          p =>
            String(
              p.name || ""
            )
              .toLowerCase() ===
            wanted
        );
    }


    if (!product) {

      throw new Error(
        "PRODUCT_NOT_FOUND"
      );
    }


    const price =
      Number(
        product.salePrice ??
        product.price
      );


    if (
      !Number.isFinite(price) ||
      price <= 0
    ) {

      throw new Error(
        `PRICE_INVALID:${product.name}`
      );
    }


    const stock =
      Number(
        product.stock
      );


    if (
      Number.isFinite(stock) &&
      stock <= 0
    ) {

      throw new Error(
        `OUT_OF_STOCK:${product.name}`
      );
    }


    if (
      Number.isFinite(stock) &&
      quantity > stock
    ) {

      throw new Error(
        `STOCK_LIMIT:${product.name}`
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
        String(
          product.name || ""
        ),

      quantity,

      unitPrice:
        Number(
          price.toFixed(2)
        )

    });
  }


  const total =
    Number(
      items
        .reduce(
          (
            sum,
            item
          ) =>
            sum +
            item.unitPrice *
            item.quantity,
          0
        )
        .toFixed(2)
    );


  if (
    !Number.isFinite(total) ||
    total <= 0
  ) {

    throw new Error(
      "CHECKOUT_TOTAL_INVALID"
    );
  }


  return {
    items,
    total
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
      "SHOPIER_SHOP_SLUG_REQUIRED"
    );
  }


  const safeProductId =
    escapeHtml(
      String(productId)
    );


  const safeSlug =
    escapeHtml(
      SHOP_SLUG
    );


  const safeQuantity =
    Math.max(
      1,
      Number(quantity) || 1
    );


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

<h1 style="
letter-spacing:4px;
">
ZANVIELLE
</h1>

<p>
Güvenli ödeme sayfasına yönlendiriliyorsunuz...
</p>

<form
id="zanvielleShopierForm"
method="POST"
action="https://www.shopier.com/s/shipping/${safeSlug}"
>

<input
type="hidden"
name="product_id"
value="${safeProductId}"
>

<input
type="hidden"
name="quantity"
value="${safeQuantity}"
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


/* =========================================================
   HEALTH
   ========================================================= */

app.get(
  "/health",
  (req, res) => {

    res.json({

      ok: true,

      service:
        "ZANVIELLE Shopier",

      time:
        new Date().toISOString(),

      node:
        process.version

    });
  }
);


/* =========================================================
   SHOPIER STATUS
   ========================================================= */

app.get(
  "/api/shopier/status",
  async (req, res) => {

    try {

      const token =
        await getAccessToken();


      res.json({

        ok: true,

        configured:
          Boolean(
            CLIENT_ID &&
            CLIENT_SECRET &&
            SERVER_URL
          ),

        authorized:
          Boolean(token),

        shopSlugConfigured:
          Boolean(
            SHOP_SLUG
          ),

        serverUrl:
          SERVER_URL,

        redirectUri:
          `${SERVER_URL}/api/shopier/callback`

      });

    } catch (error) {

      res.status(500).json({

        ok: false,

        error:
          error.message

      });
    }
  }
);


/* =========================================================
   SHOPIER BAĞLA
   ========================================================= */

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
      crypto
        .randomBytes(32)
        .toString("hex");


    saveJson(
      OAUTH_STATE_FILE,
      {

        state,

        createdAt:
          Date.now()

      }
    );


    const redirectUri =
      `${SERVER_URL}/api/shopier/callback`;


    const params =
      new URLSearchParams({

        response_type:
          "code",

        client_id:
          CLIENT_ID,

        redirect_uri:
          redirectUri,

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
  "/api/shopier/callback",
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
          `Shopier bağlantısı reddedildi: ${escapeHtml(
            error_description ||
            error
          )}`
        );
    }


    if (!code) {

      return res
        .status(400)
        .send(
          "Shopier authorization code alınamadı."
        );
    }


    const savedState =
      loadJson(
        OAUTH_STATE_FILE,
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
          "Geçersiz veya süresi dolmuş OAuth state."
        );
    }


    try {

      const redirectUri =
        `${SERVER_URL}/api/shopier/callback`;


      const data =
        await tokenRequest({

          grant_type:
            "authorization_code",

          client_id:
            CLIENT_ID,

          client_secret:
            CLIENT_SECRET,

          code:
            String(code),

          redirect_uri:
            redirectUri

        });


      saveToken(data);


      res.send(`<!doctype html>

<html lang="tr">

<head>

<meta charset="utf-8">

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>ZANVIELLE</title>

</head>

<body style="
font-family:Arial,sans-serif;
text-align:center;
padding:60px 20px;
">

<h1>ZANVIELLE</h1>

<h2 style="color:#16834b">
Shopier bağlantısı başarılı.
</h2>

<p>
Ödeme sistemi kullanıma hazır.
</p>

<a href="/">
Siteye dön
</a>

</body>

</html>`);

    } catch (error) {

      console.error(
        "[SHOPIER CALLBACK]",
        error
      );

      res
        .status(500)
        .send(
          `<pre style="white-space:pre-wrap;padding:30px;font-family:Arial">${escapeHtml(
            error.message
          )}</pre>`
        );
    }
  }
);


/* =========================================================
   ÖDEME OLUŞTUR
   ========================================================= */

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


      const token =
        await getAccessToken();


      if (!token) {

        throw new Error(
          "SHOPIER_NOT_AUTHORIZED"
        );
      }


      const normalized =
        normalizeCheckout(
          req.body?.items
        );


      const orderId =
        `ZAN-${Date.now()}-${crypto
          .randomBytes(4)
          .toString("hex")
          .toUpperCase()}`;


      const productName =
        normalized.items
          .map(
            item =>
              `${item.name} x${item.quantity}`
          )
          .join(" | ")
          .slice(0, 180);


      /*
       * Shopier'de tek seferlik sipariş ürünü
       * oluşturuyoruz.
       */

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
    
