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

  // Xác minh 1 ảnh có thật sự tải được hay không (ảnh vỡ link / 404 / chưa
  // upload sẽ resolve(false) và bị loại khỏi bộ thẻ để rút).
  function verifyImageLoads(url, timeoutMs = 8000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        resolve(ok);
      };
      const img = new Image();
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.src = url;
      setTimeout(() => finish(false), timeoutMs);
    });
  }

  async function buildCardsPool() {
    const perPage = await Promise.all(SOURCE_PAGES.map(fetchCardsFromPage));
    const merged = perPage.flat();
    // Chỉ giữ lại thẻ nào ảnh thật sự load được — không có bộ thẻ dự phòng nào khác.
    const checks = await Promise.all(
      merged.map(async (c) => ((await verifyImageLoads(c.img)) ? c : null))
    );
    return checks.filter(Boolean);
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
