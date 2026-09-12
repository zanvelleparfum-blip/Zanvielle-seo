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

const REDIRECT_URI =
  `${SERVER_URL}/api/shopier/callback`;

const ROOT = __dirname;

/*
 * index.html GitHub reposunun ana dizininde.
 * public klasörü yok.
 */
const PUBLIC = ROOT;

const DATA = path.join(ROOT, 'data');

const ORDERS_FILE =
  path.join(DATA, 'orders.json');

const TOKEN_FILE =
  path.join(DATA, '.shopier_token.json');

fs.mkdirSync(DATA, { recursive: true });


/* =========================================================
   CORS
   ========================================================= */

const ALLOWED_ORIGINS = new Set([
  'https://zanvielleparfum.com.tr',
  'https://www.zanvielleparfum.com.tr',
  'https://zanvilleparfum.com.tr',
  'https://www.zanvilleparfum.com.tr',
  'https://zanvielle-seo.onrender.com',
  'https://zanvelleparfum-blip.github.io'
]);

app.use((req, res, next) => {

  const origin = req.headers.origin;

  if (
    origin &&
    ALLOWED_ORIGINS.has(origin)
  ) {

    res.setHeader(
      'Access-Control-Allow-Origin',
      origin
    );

    res.setHeader(
      'Vary',
      'Origin'
    );

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
   BODY
   ========================================================= */

app.use(
  express.json({
    limit: '256kb'
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '256kb'
  })
);


/* =========================================================
   SHOPIER BUTON FIX
   ========================================================= */

const SHOPIER_FIX_SCRIPT = `
<script>

(function () {

  function bindShopierButton() {

    const button =
      document.getElementById(
        'zanvielleCheckoutPay'
      );

    if (
      !button ||
      button.dataset.zanvielleShopierFix === '1'
    ) {
      return;
    }

    button.dataset.zanvielleShopierFix = '1';


    button.addEventListener(
      'click',
      async function (event) {

        event.preventDefault();
        event.stopImmediatePropagation();


        /* -----------------------------------------
           HİJYEN ONAYI
           ----------------------------------------- */

        const hygiene =
          document.getElementById(
            'zanvielleCheckoutHygiene'
          );


        if (
          !hygiene ||
          !hygiene.checked
        ) {

          alert(
            'Devam etmek için hijyen bilgilendirmesini onaylamanız gerekir.'
          );

          return;
        }


        /* -----------------------------------------
           ALAN OKUMA
           ----------------------------------------- */

        const value = function (id) {

          const el =
            document.getElementById(id);

          return el
            ? String(el.value || '').trim()
            : '';

        };


        /* -----------------------------------------
           MÜŞTERİ
           ----------------------------------------- */

        const customer = {

          name:
            value('zanvielleName'),

          phone:
            value('zanviellePhone'),

          email:
            value('zanvielleEmail'),

          city:
            value('zanvielleCity'),

          address:
            value('zanvielleAddress'),

          postcode:
            '00000'

        };


        /* -----------------------------------------
           ZORUNLU ALANLAR
           ----------------------------------------- */

        if (
          !customer.name ||
          !customer.phone ||
          !customer.email ||
          !customer.city ||
          !customer.address
        ) {

          alert(
            'Lütfen tüm müşteri bilgilerini eksiksiz doldurun.'
          );

          return;
        }


        /* -----------------------------------------
           SEPET
           ----------------------------------------- */

        let items = [];


        try {

          if (
            typeof cart !== 'undefined' &&
            typeof PRODUCTS !== 'undefined'
          ) {

            items =
              Object.entries(cart)

                .map(
                  function ([id, quantity]) {

                    const product =
                      PRODUCTS.find(
                        function (p) {

                          return (
                            Number(p.id) ===
                            Number(id)
                          );

                        }
                      );


                    if (!product) {
                      return null;
                    }


                    return {

                      localId:
                        Number(product.id),

                      quantity:
                        Number(quantity)

                    };

                  }
                )

                .filter(
                  function (x) {

                    return (
                      x &&
                      Number.isInteger(
                        x.quantity
                      ) &&
                      x.quantity > 0
                    );

                  }
                );

          }

        } catch (err) {

          console.error(
            'ZANVIELLE cart error:',
            err
          );

        }


        /* -----------------------------------------
           SEPET BOŞ
           ----------------------------------------- */

        if (!items.length) {

          alert(
            'Sepetiniz boş. Önce ürün ekleyin.'
          );

          return;
        }


        /* -----------------------------------------
           BUTON
           ----------------------------------------- */

        const oldText =
          button.textContent;


        button.disabled = true;

        button.textContent =
          'SHOPIER ÖDEME HAZIRLANIYOR…';


        /* -----------------------------------------
           SHOPIER API
           ----------------------------------------- */

        try {

          const response =
            await fetch(
              'https://zanvielle-seo.onrender.com/api/shopier/checkout',
              {

                method: 'POST',

                headers: {
                  'Content-Type':
                    'application/json'
                },

                body:
                  JSON.stringify({

                    items:
                      items,

                    customer:
                      customer

                  })

              }
            );


          const data =
            await response
              .json()
              .catch(
                function () {
                  return {};
                }
              );


          console.log(
            'ZANVIELLE SHOPIER RESPONSE:',
            data
          );


          /* -----------------------------------------
             HATA
             ----------------------------------------- */

          if (
            !response.ok ||
            !data.ok
          ) {

            throw new Error(
              data.error ||
              (
                'CHECKOUT_HTTP_' +
                response.status
              )
            );

          }


          /* -----------------------------------------
             CHECKOUT HTML
             ----------------------------------------- */

          if (
            data.checkoutHtml
          ) {

            const blob =
              new Blob(
                [
                  data.checkoutHtml
                ],
                {
                  type:
                    'text/html;charset=utf-8'
                }
              );


            const shopierUrl =
              URL.createObjectURL(
                blob
              );


            window.location.href =
              shopierUrl;


            return;

          }


          /* -----------------------------------------
             CHECKOUT URL
             ----------------------------------------- */

          if (
            data.checkoutUrl
          ) {

            window.location.href =
              data.checkoutUrl;

            return;

          }


          /* -----------------------------------------
             REDIRECT URL
             ----------------------------------------- */

          if (
            data.redirectUrl
          ) {

            window.location.href =
              data.redirectUrl;

            return;

          }


          throw new Error(
            'Shopier ödeme bağlantısı oluşturulamadı.'
          );

        }

        catch (error) {

          console.error(
            'ZANVIELLE SHOPIER:',
            error
          );


          alert(
            'Ödeme bağlantısı oluşturulamadı.\\n\\n' +
            (
              error.message ||
              'Bilinmeyen hata'
            )
          );


          button.disabled =
            false;


          button.textContent =
            oldText;

        }

      },

      true

    );

  }


  /* -----------------------------------------
     SAYFA YÜKLENİNCE
     ----------------------------------------- */

  if (
    document.readyState ===
    'loading'
  ) {

    document.addEventListener(
      'DOMContentLoaded',
      bindShopierButton
    );

  }

  else {

    bindShopierButton();

  }


  /* -----------------------------------------
     EK KONTROLLER
     ----------------------------------------- */

  setTimeout(
    bindShopierButton,
    500
  );

  setTimeout(
    bindShopierButton,
    1500
  );

  setTimeout(
    bindShopierButton,
    3000
  );


})();

</script>
`;


/* =========================================================
   INDEX.HTML'İ SHOPIER FIX İLE SERVİS ET
   ========================================================= */

function sendIndexWithShopierFix(
  req,
  res
) {

  const indexPath =
    path.join(
      ROOT,
      'index.html'
    );


  if (
    !fs.existsSync(indexPath)
  ) {

    return res
      .status(404)
      .send(
        'index.html bulunamadı.'
      );

  }


  let html =
    fs.readFileSync(
      indexPath,
      'utf8'
    );


  if (
    !html.includes(
      'ZANVIELLE SHOPIER BUTON FIX'
    )
  ) {

    html =
      html.replace(
        '</body>',
        '<!-- ZANVIELLE SHOPIER BUTON FIX -->' +
        SHOPIER_FIX_SCRIPT +
        '\\n</body>'
      );

  }


  res.setHeader(
    'Content-Type',
    'text/html; charset=utf-8'
  );


  res.send(html);

}


/* =========================================================
   INDEX ROUTE
   ========================================================= */

app.get(
  [
    '/',
    '/index.html'
  ],
  sendIndexWithShopierFix
);


/* =========================================================
   STATIC
   ========================================================= */

app.use(
  express.static(PUBLIC)
);


/* =========================================================
   JSON HELPERS
   ========================================================= */

function loadJson(
  file,
  fallback
) {

  try {

    return JSON.parse(
      fs.readFileSync(
        file,
        'utf8'
      )
    );

  }

  catch {

    return fallback;

  }

}


function saveJson(
  file,
  value
) {

  const tmp =
    `${file}.tmp`;


  fs.writeFileSync(
    tmp,
    JSON.stringify(
      value,
      null,
      2
    )
  );


  fs.renameSync(
    tmp,
    file
  );

}


/* =========================================================
   HELPERS
   ========================================================= */

function clean(
  v,
  max = 300
) {

  return String(
    v ?? ''
  )
    .trim()
    .slice(
      0,
      max
    );

}


function normalizePhone(v) {

  return clean(
    v,
    30
  ).replace(
    /[^0-9+]/g,
    ''
  );

}


function money(n) {

  return Number(n)
    .toFixed(2);

}


function esc(v) {

  return String(
    v ?? ''
  ).replace(
    /[&<>"']/g,
    function (c) {

      return {

        '&':
          '&amp;',

        '<':
          '&lt;',

        '>':
          '&gt;',

        '"':
          '&quot;',

        "'":
          '&#39;'

      }[c];

    }
  );

}


/* =========================================================
   STORAGE
   ========================================================= */

let orders =
  loadJson(
    ORDERS_FILE,
    {}
  );


let tokenStore =
  loadJson(
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
      data.access_token ||
      '',

    refresh_token:
      data.refresh_token ||
      '',

    expires_at:
      data.expires_in
        ? Date.now() +
          Number(
            data.expires_in
          ) *
          1000 -
          60000
        : 0

  };


  saveJson(
    TOKEN_FILE,
    tokenStore
  );

}


/* =========================================================
   KATALOG
   ========================================================= */

function loadCatalog() {

  const indexPath =
    path.join(
      ROOT,
      'index.html'
    );


  if (
    !fs.existsSync(indexPath)
  ) {

    throw new Error(
      'INDEX_HTML_NOT_FOUND'
    );

  }


  const html =
    fs.readFileSync(
      indexPath,
      'utf8'
    );


  const m =
    html.match(
      /const PRODUCTS\s*=\s*([\s\S]*?);\s*\n/
    );


  if (!m) {

    throw new Error(
      'PRODUCT_CATALOG_NOT_FOUND'
    );

  }


  return JSON.parse(
    m[1]
  );

}


/* =========================================================
   CHECKOUT NORMALIZE
   ========================================================= */

function normalizeCheckout(
  rawItems,
  customer
) {

  if (
    !Array.isArray(
      rawItems
    ) ||
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
      catalog.map(
        function (p) {

          return [
            Number(p.id),
            p
          ];

        }
      )
    );


  const merged =
    new Map();


  for (
    const raw of rawItems
  ) {

    const id =
      Number(
        raw?.localId
      );


    const qty =
      Number(
        raw?.quantity
      );


    const p =
      byId.get(id);


    if (
      !p ||
      !Number.isInteger(
        qty
      ) ||
      qty < 1 ||
      qty > 99
    ) {

      throw new Error(
        'CHECKOUT_ITEM_INVALID'
      );

    }


    if (
      Number(p.stock) <= 0
    ) {

      throw new Error(
        `OUT_OF_STOCK:${p.name}`
      );

    }


    merged.set(
      id,
      (
        merged.get(id) ||
        0
      ) + qty
    );

  }


  const items = [];


  for (
    const [
      id,
      qty
    ] of merged
  ) {

    const p =
      byId.get(id);


    if (
      qty >
      Number(p.stock)
    ) {

      throw new Error(
        `STOCK_LIMIT:${p.name}`
      );

    }


    const unit =
      Number(
        p.salePrice ??
        p.price
      );


    if (!(unit > 0)) {

      throw new Error(
        `PRICE_INVALID:${p.name}`
      );

    }


    items.push({

      localId:
        Number(p.id),

      shopierId:
        Number(
          p.shopierId ||
          0
        ),

      name:
        String(
          p.name
        ),

      quantity:
        qty,

      unitPrice:
        Number(
          unit.toFixed(2)
        )

    });

  }


  const total =
    Number(
      items
        .reduce(
          function (
            s,
            x
          ) {

            return (
              s +
              x.unitPrice *
              x.quantity
            );

          },
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
   SHOPIER TOKEN REQUEST
   ========================================================= */

async function tokenRequest(
  params
) {

  const response =
    await fetch(
      SHOPIER_TOKEN_URL,
      {

        method:
          'POST',

        headers: {

          'Content-Type':
            'application/x-www-form-urlencoded',

          'Accept':
            'application/json'

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
      JSON.parse(
        text
      );

  }

  catch {

    data = {
      raw: text
    };

  }


  if (
    !response.ok
  ) {

    const msg =
      data.error_description ||
      data.error ||
      data.raw ||
      `HTTP_${response.status}`;


    throw new Error(
      `SHOPIER_TOKEN_ERROR:${msg}`
    );

  }


  return data;

}


/* =========================================================
   REFRESH TOKEN
   ========================================================= */

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


  saveToken(
    data
  );


  return tokenStore.access_token;

}


/* =========================================================
   ACCESS TOKEN
   ========================================================= */

async function getAccessToken() {

  if (
    tokenStore.access_token &&
    Date.now() <
    Number(
      tokenStore.expires_at ||
      0
    )
  ) {

    return tokenStore.access_token;

  }


  if (
    tokenStore.refresh_token
  ) {

    try {

      return await refreshAccessToken();

    }

    catch (e) {

      console.warn(
        '[shopier] refresh failed:',
        e.message
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
