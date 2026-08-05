import { test } from 'node:test';
import assert from 'node:assert';
import {
  safeName,
  escapeHtml,
  distanceKm,
  formatDistance,
  formatDate,
  normalizeSearchText,
  matchedDishOf,
  matchesSearch,
  locationLabel,
  regionOf,
  FOOD_ICONS,
  pickFoodIcon,
  arcControlPoint,
  quadraticPoint,
  arcPoints,
  bendFor,
} from '../map-core.mjs';

test('safeName: 与 dataDir 相同的清洗规则,汉字保留、特殊字符换下划线', () => {
  assert.strictEqual(safeName('陈晓卿'), '陈晓卿');
  assert.strictEqual(safeName('a/b\\c:d'), 'a_b_c_d');
});

test('escapeHtml: 五个 HTML 特殊字符全部转义(弹窗/侧栏插值都靠它挡 XSS)', () => {
  assert.strictEqual(
    escapeHtml(`<img src=x onerror="alert('1')" & >`),
    '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot; &amp; &gt;'
  );
  assert.strictEqual(escapeHtml(123), '123'); // 非字符串也不抛错
});

test('distanceKm: 北京-上海约 1068km,同点为 0', () => {
  const d = distanceKm(39.9042, 116.4074, 31.2304, 121.4737);
  assert.ok(Math.abs(d - 1068) < 10, `got ${d}`);
  assert.strictEqual(distanceKm(30, 120, 30, 120), 0);
});

test('formatDistance: 1km 以下用米,10km 以下带一位小数,更远取整', () => {
  assert.strictEqual(formatDistance(0.4321), '432m');
  assert.strictEqual(formatDistance(5.67), '5.7km');
  assert.strictEqual(formatDistance(123.4), '123km');
});

test('formatDate: 微博日期字符串和数字时间戳都出 YYYY-MM-DD,垃圾输入原样返回', () => {
  // formatDate 按查看者本地时区取年月日,断言不能用会跨日期线的时刻——
  // 首版用了 +0800 的零点,本机(UTC+8)是 07-17、CI(UTC)是 07-16,
  // 在 CI 上红了。字符串用例取当天中午,数字时间戳取 UTC 正午(±11 个
  // 时区内都是同一个日历日),两种输入在任何时区都稳定。
  assert.strictEqual(
    formatDate('Sat Dec 03 16:48:49 +0800 2011'),
    formatDate(Date.parse('Sat Dec 03 16:48:49 +0800 2011'))
  );
  assert.match(formatDate('Sat Dec 03 16:48:49 +0800 2011'), /^2011-12-0[23]$/);
  // 数字时间戳曾直接漏成 "1784273990000" 显示给用户——typeof 分支就是防它的
  assert.strictEqual(formatDate(Date.parse('2026-07-17T12:00:00Z')), '2026-07-17');
  assert.strictEqual(formatDate('不是日期'), '不是日期');
  assert.strictEqual(formatDate(null), '');
});

test('normalizeSearchText: 去全部空白(含全角)再小写,"陈 记"能搜到"陈记"', () => {
  assert.strictEqual(normalizeSearchText(' Chen 记\u3000A '), 'chen记a');
  assert.strictEqual(normalizeSearchText(null), '');
});

test('matchedDishOf/matchesSearch: 店名不中时按菜品命中,并返回那道菜原文', () => {
  const r = { name: '利苑', visits: [{ dishes: ['干炒牛河', '烧鹅'] }, { dishes: [] }] };
  assert.strictEqual(matchedDishOf(r, normalizeSearchText('牛河')), '干炒牛河');
  assert.strictEqual(matchesSearch(r, normalizeSearchText('牛河')), true);
  assert.strictEqual(matchesSearch(r, normalizeSearchText('烤鸭')), false);
  assert.strictEqual(matchesSearch(r, ''), true); // 空查询放行一切
});

test('locationLabel: 国内 省·市,国外 国家·市,直辖市去重,老数据退回 region', () => {
  assert.strictEqual(
    locationLabel({ location: { country: '中国', province: '广东省', city: '顺德区' } }),
    '广东省 · 顺德区'
  );
  assert.strictEqual(locationLabel({ location: { country: '新加坡', city: '新加坡' } }), '新加坡');
  assert.strictEqual(locationLabel({ location: { country: '法国', city: '里昂' } }), '法国 · 里昂');
  assert.strictEqual(locationLabel({ region: '湖南' }), '湖南');
  assert.strictEqual(locationLabel({}), null);
});

test('regionOf: 结构化 location 优先,city 缺失退回扁平 region', () => {
  assert.deepStrictEqual(
    regionOf({ location: { continent: '亚洲', country: '中国', province: '广东省', city: '广州市' } }),
    {
      continent: '亚洲',
      country: '中国',
      province: '广东省',
      city: '广州市',
    }
  );
  assert.deepStrictEqual(regionOf({ region: '北京' }), {
    continent: null,
    country: null,
    province: null,
    city: '北京',
  });
});

test('pickFoodIcon: 同名稳定同图标,结果都在图标清单里', () => {
  assert.strictEqual(pickFoodIcon('猪肉婆'), pickFoodIcon('猪肉婆'));
  for (const n of ['猪肉婆', '汪姐家', 'Sushi Den']) assert.ok(FOOD_ICONS.includes(pickFoodIcon(n)));
});

test('弧线数学: t=0/1 落在两端点,中点偏移方向与 bend 成正比', () => {
  const a = { lat: 39.9, lng: 116.4 };
  const b = { lat: 31.2, lng: 121.5 };
  const ctrl = arcControlPoint(a, b, bendFor(true));
  assert.deepStrictEqual(quadraticPoint(a, ctrl, b, 0), a);
  assert.deepStrictEqual(quadraticPoint(a, ctrl, b, 1), b);
  // 画线和图标滑动共用同一条曲线:arcPoints 的中间采样点必须等于 quadraticPoint(t=0.5)
  const pts = arcPoints(a, b, bendFor(true), 24);
  assert.strictEqual(pts.length, 25);
  const mid = quadraticPoint(a, ctrl, b, 0.5);
  assert.deepStrictEqual(pts[12], [mid.lat, mid.lng]);
  // bend=0 时是直线(控制点即中点)
  const straight = arcControlPoint(a, b, 0);
  assert.deepStrictEqual(straight, { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 });
});

test('bendFor: 飞机弧度大于汽车(视觉隐喻的既定比例)', () => {
  assert.ok(bendFor(true) > bendFor(false));
});
