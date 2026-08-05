// 地图页(app.js)里不碰 DOM/Leaflet 的纯逻辑,抽出来单独成模块的动机:
// app.js 作为浏览器脚本没法被 node:test 加载,这里面的格式化/搜索匹配/
// 弧线数学曾经是全仓唯一"有真实行为却测不到"的一块。浏览器侧由 app.js
// 以 ES module 引入(<script type="module">,仍是零构建),Node 侧由
// test/map-core.test.mjs 直接 import——两边跑的是同一份代码。
//
// 收录标准:纯函数、不依赖 window/document/L。取景(frameRestaurants)、
// 弹窗渲染这类要碰地图实例或拼 DOM 的留在 app.js。

/** 与 extract-restaurants.mjs 的 dataDir() 保持一致的目录名清洗规则。 */
export function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9一-鿿]/g, '_');
}

export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/** 球面距离(公里),Haversine 公式,用于"附近好吃的"排序。 */
export function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function formatDistance(km) {
  return km < 1 ? `${Math.round(km * 1000)}m` : `${km.toFixed(km < 10 ? 1 : 0)}km`;
}

export function formatDate(raw) {
  // Date.parse 只认字符串——数字类型的时间戳传进来会先被强制转成字符串
  // (比如 "1784273990000"),不是合法的日期格式,直接判定 NaN 走进原样
  // 返回的兜底分支。数据新鲜度提示传的就是 Math.max(...timestamps) 算出
  // 来的数字,不特殊处理这里会直接把时间戳数字显示给用户看。
  const t = typeof raw === 'number' ? raw : Date.parse(raw);
  if (isNaN(t)) return raw || '';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 去空格再转小写——只做小写转换的话,店名/查询词里偶尔有的空格(全角/
// 半角)会让本该命中的结果搜不到,比如"陈 记"搜"陈记"落空。搜索同时驱动
// 侧栏列表和地图图层(见 app.js setupFilters 的 apply()),两边必须用同
// 一套匹配逻辑,不然会出现"列表里有、地图上没有"。
export function normalizeSearchText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * 店名搜不到时,再看看是不是搜的是某道推荐菜——数据里每次拜访都存了
 * 菜品,搜"牛河"应该能翻出"利苑"这种店名完全不沾边的结果。命中就返回
 * 那道菜的原文,用于在列表里标注"因为这道菜被搜到"。
 */
export function matchedDishOf(r, q) {
  for (const v of r.visits) {
    for (const d of v.dishes || []) {
      if (normalizeSearchText(d).includes(q)) return d;
    }
  }
  return null;
}

export function matchesSearch(r, q) {
  if (!q) return true;
  return normalizeSearchText(r.name).includes(q) || !!matchedDishOf(r, q);
}

/**
 * 弹窗标题下那行"店在哪":国内显示 省·市,国外显示 国家·市(直辖市这类
 * 省市同名的去重成一段);没跑过地区反查的老数据退回 region(发帖 IP
 * 归属地,粗但聊胜于无)。没有任何位置信息时返回 null,弹窗不渲染这一行。
 */
export function locationLabel(r) {
  const loc = r.location || {};
  const parts = loc.country === '中国' ? [loc.province, loc.city] : [loc.country, loc.city];
  return [...new Set(parts.filter(Boolean))].join(' · ') || r.region || null;
}

/**
 * 侧栏级联筛选用的行政层级,兼容两种数据来源:geocode-regions.mjs 写入的
 * 结构化 location(优先),或旧版按发帖 IP 算出的扁平 region 字段(退化成
 * "只有市"这一级)。
 */
export function regionOf(r) {
  const loc = r.location || {};
  return {
    continent: loc.continent || null,
    country: loc.country || null,
    province: loc.province || null,
    city: loc.city || r.region || null,
  };
}

// 按名称哈希挑一个食物图标,同一家餐厅在标记/侧栏/弹窗里始终显示同一个。
// 图标本体是微软 Fluent Emoji 的 3D 渲染图(MIT 协议,存在 assets/food-icons/ 下)。
export const FOOD_ICONS = [
  'dumpling',
  'oden',
  'fried_shrimp',
  'curry_rice',
  'cooked_rice',
  'bento_box',
  'cut_of_meat',
  'pancakes',
  'fish',
  'dango',
  'cookie',
  'fortune_cookie',
];

export function pickFoodIcon(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % FOOD_ICONS.length;
  return FOOD_ICONS[h];
}

// ---- 轨迹回放的弧线数学 ----
// 远距离(飞机)的一段画成二次贝塞尔弧线而不是直线:取两点中点,往垂直
// 方向偏移一点当控制点,弯曲程度跟距离成比例。画线(arcPoints)和让飞机
// 图标沿线滑动(app.js 的 animateMarkerTo)必须共用同一个控制点、同一条
// 曲线——之前两边各算一套,图标走直线、背后的线却是弯的,对不上。

export function arcControlPoint(a, b, bend) {
  const midLat = (a.lat + b.lat) / 2,
    midLng = (a.lng + b.lng) / 2;
  const dLat = b.lat - a.lat,
    dLng = b.lng - a.lng;
  return { lat: midLat - dLng * bend, lng: midLng + dLat * bend };
}

export function quadraticPoint(a, ctrl, b, t) {
  return {
    lat: (1 - t) ** 2 * a.lat + 2 * (1 - t) * t * ctrl.lat + t ** 2 * b.lat,
    lng: (1 - t) ** 2 * a.lng + 2 * (1 - t) * t * ctrl.lng + t ** 2 * b.lng,
  };
}

export function arcPoints(a, b, bend, steps = 24) {
  const ctrl = arcControlPoint(a, b, bend);
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const p = quadraticPoint(a, ctrl, b, i / steps);
    pts.push([p.lat, p.lng]);
  }
  return pts;
}

/** 开车(近距离)的弧度比飞机(远距离)小得多——短途弓成长途的弧度会显得很夸张。 */
export function bendFor(isFar) {
  return isFar ? 0.45 : 0.15;
}
