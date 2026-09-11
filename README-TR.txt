ZANVIELLE — SHOPIER DOĞRUDAN ÖDEME ALTYAPISI

Akış:
ZANVIELLE SEPETİ
 -> müşteri bilgileri (bir kez)
 -> /api/shopier/checkout
 -> sunucu tarafında imzalı Shopier ödeme formu
 -> Shopier güvenli ödeme sayfası
 -> /api/shopier/callback
 -> sipariş durumu

ÖNEMLİ
- Bu sürüm mevcut Shopier ürün linklerine ve Shopier'in eski müşteri sepetine yönlendirme yapmaz.
- Sepetteki ürünler sunucu tarafından index.html içindeki güncel katalog/fiyat/stok ile tekrar doğrulanır.
- Kart bilgileri ZANVIELLE sunucusuna alınmaz; tarayıcı Shopier ödeme gateway'ine POST edilir.
- API key/secret sadece .env içinde sunucuda tutulur.
- Bu ödeme formu, bağımsız Shopier ödeme SDK'larında kullanılan klasik api_pay4.php imzalı form akışına dayanır; bu endpoint'in güncel hesapta aktif olup olmadığı gerçek Shopier hesabında test edilmelidir.
- Ödeme başarılı sayılmadan sipariş paid yapılmaz; callback imzası kontrol edilir.

KURULUM
1. Node.js 18+ yükleyin.
2. npm install
3. .env.example dosyasını .env olarak kopyalayın.
4. SERVER_URL, SHOPIER_API_KEY ve SHOPIER_API_SECRET değerlerini girin.
5. npm start
6. /api/shopier/status adresinde configured:true görünmeli.

TEST
- Önce /api/shopier/status kontrol edilir.
- Sonra ZANVIELLE'de bir ürün sepete eklenir.
- Sepetten güvenli ödeme adımına geçilir.
- Ad soyad, e-posta, telefon, il, posta kodu ve açık adres bir kez girilir.
- Shopier ödeme ekranına geçilir.
- Test ödeme sonrası callback /api/shopier/callback tarafından alınır.

NOT
Shopier'in güncel Developer Portalı OAuth/PAT ile API erişimi ve webhookları belgeler. Bu doğrudan ödeme formu ayrı, eski/bağımsız bir ödeme-gateway yaklaşımıdır. Canlıya almadan önce Shopier hesabınızda ödeme modülü/API key-secret ile gerçek test yapılmalıdır.
