/* ====================================================================
   cards-pool.js
   --------------------------------------------------------------------
   Module dùng chung để quét + xác minh bộ thẻ ảnh thật, có thể gọi từ
   BẤT KỲ trang nào (index.html, rut-the.html, …) trong cùng thư mục.

   Cách dùng:
   - Nhúng file này bằng <script src="cards-pool.js"></script> ở trang
     nào cũng được (index.html, rut-the.html…).
   - Gọi CardsPool.warmCardsPool() càng sớm càng tốt (ví dụ ngay khi
     index.html vừa mở) để bắt đầu quét + xác minh ảnh trong lúc người
     dùng còn đang xem trang chủ.
   - Ở rut-the.html, gọi CardsPool.getCardsPool() để lấy kết quả — nếu
     đã quét sẵn từ trang trước (còn nằm trong sessionStorage, chưa hết
     hạn), trả về NGAY LẬP TỨC, không phải quét lại từ đầu.

   sessionStorage chỉ tồn tại trong cùng 1 tab/cửa sổ trình duyệt và tự
   xoá khi đóng tab — phù hợp cho vòng "mở trang chủ -> bấm vào rút thẻ"
   trong cùng 1 phiên, không lưu vĩnh viễn giữa các lượt truy cập khác.
   ==================================================================== */
(function (window) {
  const SOURCE_PAGES = [
    'cong-dien-hoi-ngo.html',
    'cong-dien-1.html',
    'cong-dien-2.html',
    'cong-dien-3.html',
    'cong-dien-4.html',
    'cong-dien-5.html',
    'chung-ket.html'
  ];

  // Tên hiển thị (badge) cho từng trang nguồn — khớp với tiêu đề các tile ở index.html.
  const PAGE_TITLES = {
    'cong-dien-hoi-ngo.html': 'Công Diễn Hội Ngộ',
    'cong-dien-1.html': 'Công Diễn 1',
    'cong-dien-2.html': 'Công Diễn 2',
    'cong-dien-3.html': 'Công Diễn 3',
    'cong-dien-4.html': 'Công Diễn 4',
    'cong-dien-5.html': 'Công Diễn 5',
    'chung-ket.html': 'Chung Kết'
  };

  const CACHE_KEY = 'cardsPool.v1';
  const CACHE_MAX_AGE_MS = 15 * 60 * 1000; // 15 phút — tránh dữ liệu cũ nếu phiên mở quá lâu

  // ---------------------------------------------------------------------
  // QUAN TRỌNG: các trang công diễn (cong-dien-1.html, cong-dien-hoi-ngo.html…)
  // chèn ảnh thẻ vào DOM bằng JavaScript lúc trang CHẠY trong trình duyệt
  // (hàm makeSlot() ở mỗi trang tạo ra .art style="background-image:...").
  // fetch() ở đây chỉ tải về HTML THÔ, KHÔNG chạy script — nên .slot .art
  // không bao giờ tồn tại trong doc parse ra, dù trang nguồn đã có ảnh thật.
  // => Phải đọc thẳng mảng dữ liệu tĩnh `const CARDS = [...]` bằng regex
  //    trên chính chuỗi HTML thô (mảng này luôn có sẵn dạng text, không
  //    phụ thuộc script đã chạy hay chưa). Tên mục (collection-title) vẫn
  //    lấy được bình thường qua DOMParser vì đó là markup tĩnh có sẵn.
  // ---------------------------------------------------------------------
  function extractCardsFromHtml(html, doc, source) {
    const titleByMuc = {};
    doc.querySelectorAll('.muc-block').forEach((block) => {
      const numEl = block.querySelector('.collection-num');
      const titleEl = block.querySelector('.collection-title');
      const muc = numEl ? parseInt(numEl.textContent, 10) : null;
      if (!muc) return;
      const title = titleEl ? titleEl.textContent.trim() : '';
      if (title && !/^mục\s*0*\d+$/i.test(title)) titleByMuc[muc] = title;
    });

    const found = [];
    const arrayMatch = html.match(/const\s+CARDS\s*=\s*\[([\s\S]*?)\];/);
    if (arrayMatch) {
      const body = arrayMatch[1];
      const entryRe = /\{\s*muc\s*:\s*(\d+)\s*,\s*img\s*:\s*["']([^"']+)["']\s*\}/g;
      let m;
      while ((m = entryRe.exec(body))) {
        const muc = parseInt(m[1], 10);
        const img = m[2].trim();
        if (!img) continue;
        found.push({ muc, img, source, title: titleByMuc[muc] || '' });
      }
    }
    return found;
  }

  async function fetchCardsFromPage(url) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return [];
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const cards = extractCardsFromHtml(html, doc, PAGE_TITLES[url] || url);
      // Chuẩn hoá đường dẫn ảnh về URL tuyệt đối theo trang nguồn.
      return cards.map((c) => ({ ...c, img: new URL(c.img, res.url).href }));
    } catch (err) {
      return [];
    }
  }

  const IMG_CACHE_KEY = 'cardsPool.imgVerified.v1';
  const IMG_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 giờ

  // Cache riêng cho "ảnh nào đã xác minh load được" — sống lâu hơn nhiều so
  // với cache của cả bộ thẻ (sessionStorage 15 phút), lưu ở localStorage nên
  // giữ được cả sau khi đóng tab/trình duyệt. Nhờ vậy, những lần quét sau
  // (kể cả mở lại vào hôm sau) sẽ bỏ qua hẳn bước gọi mạng cho các ảnh đã
  // biết chắc là tồn tại — chỉ còn phải kiểm tra ảnh MỚI thật sự.
  let imgCache = null;
  function getImgCache() {
    if (imgCache) return imgCache;
    try {
      const raw = localStorage.getItem(IMG_CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      imgCache = (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (err) {
      imgCache = {};
    }
    return imgCache;
  }
  let imgCacheDirty = false;
  function isImgVerifiedFresh(url) {
    const t = getImgCache()[url];
    return typeof t === 'number' && (Date.now() - t) < IMG_CACHE_MAX_AGE_MS;
  }
  function markImgVerified(url) {
    getImgCache()[url] = Date.now();
    imgCacheDirty = true;
  }
  function flushImgCache() {
    if (!imgCacheDirty) return;
    try {
      localStorage.setItem(IMG_CACHE_KEY, JSON.stringify(getImgCache()));
    } catch (err) {
      // localStorage đầy/bị chặn — bỏ qua, chỉ mất tác dụng cache, không lỗi.
    }
    imgCacheDirty = false;
  }

  // Xác minh bằng <img> thật (tải trọn ảnh) — chỉ dùng làm phương án dự
  // phòng khi HEAD request thất bại (một số server tĩnh chặn method HEAD).
  function verifyImageViaImgTag(url, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        resolve(ok);
      };
      const img = new Image();
      if ('fetchPriority' in img) img.fetchPriority = 'high';
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.src = url;
      setTimeout(() => finish(false), timeoutMs);
    });
  }

  // Xác minh 1 ảnh có thật sự tồn tại hay không — ƯU TIÊN dùng HEAD request
  // (chỉ hỏi header, KHÔNG tải dữ liệu ảnh) nên nhanh hơn nhiều so với tải
  // trọn file ảnh, nhất là khi có nhiều ảnh kiểm tra cùng lúc. Nếu HEAD bị
  // server từ chối/không hỗ trợ, tự động rơi về cách cũ (tải bằng <img>).
  async function verifyImageLoads(url, timeoutMs = 6000) {
    if (isImgVerifiedFresh(url)) return true;

    let ok = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        ok = true;
      } else if (res.status === 405 || res.status === 501) {
        // Server không hỗ trợ HEAD — thử lại bằng cách tải ảnh thật.
        ok = await verifyImageViaImgTag(url, timeoutMs);
      } else {
        ok = false;
      }
    } catch (err) {
      // Lỗi mạng/CORS khi HEAD — vẫn có thể do server chặn HEAD nhưng cho GET,
      // nên thử lại bằng <img> trước khi kết luận ảnh không tồn tại.
      ok = await verifyImageViaImgTag(url, timeoutMs);
    }

    if (ok) markImgVerified(url);
    return ok;
  }

  async function buildCardsPool() {
    // Quét theo pipeline: mỗi trang công diễn tự tải HTML rồi xác minh ảnh
    // của CHÍNH trang đó ngay khi vừa đọc xong — không phải đợi tải hết mọi
    // trang rồi mới bắt đầu xác minh ảnh (giúp trang nhanh không bị trang
    // chậm hơn kéo lùi thời điểm bắt đầu kiểm tra ảnh của nó).
    const perPage = await Promise.all(
      SOURCE_PAGES.map(async (url) => {
        const cards = await fetchCardsFromPage(url);
        const checked = await Promise.all(
          cards.map(async (c) => ((await verifyImageLoads(c.img)) ? c : null))
        );
        return checked.filter(Boolean);
      })
    );
    flushImgCache();
    // Chỉ giữ lại thẻ nào ảnh thật sự tồn tại — không có bộ thẻ dự phòng nào khác.
    return perPage.flat();
  }

  function readCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.pool)) return null;
      if (Date.now() - parsed.time > CACHE_MAX_AGE_MS) return null;
      return parsed.pool;
    } catch (err) {
      return null;
    }
  }

  function writeCache(pool) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ time: Date.now(), pool }));
    } catch (err) {
      // sessionStorage đầy/bị chặn — bỏ qua, chỉ mất tác dụng cache, không lỗi.
    }
  }

  function withTimeout(promise, ms, fallbackValue) {
    return Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms))
    ]);
  }

  // Chỉ build 1 lần trong vòng đời của trang hiện tại (đỡ tải mạng lặp lại
  // nếu getCardsPool() được gọi nhiều lần trên cùng 1 trang).
  let poolPromise = null;

  function getCardsPoolPromise() {
    if (poolPromise) return poolPromise;
    const cached = readCache();
    if (cached) {
      poolPromise = Promise.resolve(cached);
      return poolPromise;
    }
    poolPromise = buildCardsPool().then((pool) => {
      writeCache(pool);
      return pool;
    });
    return poolPromise;
  }

  // Gọi hàm này ngay khi trang vừa mở (ví dụ ở index.html) để bắt đầu quét +
  // xác minh ảnh trong lúc người dùng còn đang xem trang chủ — không cần
  // quan tâm kết quả trả về ở đây.
  function warmCardsPool() {
    getCardsPoolPromise();
  }

  // Dùng ở trang rút thẻ: có timeout để không treo UI quá lâu nếu mạng chậm.
  function getCardsPool(timeoutMs = 12000) {
    return withTimeout(getCardsPoolPromise(), timeoutMs, []);
  }

  window.CardsPool = {
    SOURCE_PAGES,
    PAGE_TITLES,
    warmCardsPool,
    getCardsPool
  };
})(window);
