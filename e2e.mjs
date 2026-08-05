// 端到端交互测试:起真实 server.mjs + 真实 Chrome,把桌面/移动端曾经出过
// bug 的交互逐条钉住。这批断言全部来自实际抓到过缺陷的场景,不是仪式性
// 覆盖:空筛选集退出回放曾抛 "Bounds are not valid."、回放中点侧栏曾静默
// 无响应、筛选/搜索曾与地图图层失联、移动端弹窗曾被侧栏整个盖住……
//
// 不进默认 `npm test`(放在仓库根目录,node --test 的默认发现规则只认
// test/ 目录和 *.test.* 命名),也不进 CI(CI 靠 .puppeteerrc.cjs 跳过了
// Chrome 下载)。本地跑:npm run test:e2e——需要装有 Chrome/Chromium。
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const { resolveChromePath } = require('./lib/chrome-path.js');

const PORT = 3987; // 避开开发常用的 3457,e2e 和手工调试可以同时跑
const BASE = `http://127.0.0.1:${PORT}/?name=%E9%99%88%E6%99%93%E5%8D%BF`;

let server, browser;
const pageErrors = []; // 所有页面的未捕获异常都收进来,最后一个用例统一断言为空

before(async () => {
  server = spawn('node', ['server.mjs', '--port', String(PORT)], { cwd: import.meta.dirname });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => String(d).includes('美食地图') && resolve());
    server.on('error', reject);
    setTimeout(() => reject(new Error('server 未在 10s 内就绪')), 10000);
  });
  browser = await puppeteer.launch({ headless: 'new', executablePath: resolveChromePath('') });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
});

/** 新开一页并等地图数据就绪(统计行出现"家餐厅")。 */
async function openPage({ mobile = false } = {}) {
  const page = await browser.newPage();
  page.on('pageerror', e => pageErrors.push(String(e).slice(0, 160)));
  await page.setViewport(
    mobile
      ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
      : { width: 1280, height: 900 }
  );
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => /家餐厅/.test(document.getElementById('stat').textContent), { timeout: 15000 });
  return page;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('初始加载: 统计行、地图标记、数据新鲜度齐全', { timeout: 60000 }, async () => {
  const page = await openPage();
  const s = await page.evaluate(() => ({
    stat: document.getElementById('stat').textContent,
    markers: document.querySelectorAll('.leaflet-marker-icon').length,
    freshness: document.getElementById('dataFreshness').textContent,
  }));
  assert.match(s.stat, /^\d+ 家餐厅 · \d+ 次拜访$/);
  assert.ok(s.markers > 0, '地图上应有标记/聚类气泡');
  assert.match(s.freshness, /数据含最近拜访:\d{4}-\d{2}-\d{2}/);
  await page.close();
});

test('引导气泡: 同屏只有一个,点掉才轮到下一个', { timeout: 60000 }, async () => {
  const page = await openPage();
  await page.waitForSelector('.pointer-hint.show', { timeout: 10000 });
  const first = await page.evaluate(() => {
    const hints = document.querySelectorAll('.pointer-hint');
    return { count: hints.length, text: hints[0]?.textContent };
  });
  assert.strictEqual(first.count, 1, '气泡一次只能弹一个');
  await page.evaluate(() => document.querySelector('.pointer-hint').click());
  await page.waitForFunction(
    prev => {
      const h = document.querySelector('.pointer-hint.show');
      return h && h.textContent !== prev;
    },
    { timeout: 5000 },
    first.text
  );
  await page.close();
});

test('弹窗: 带位置行,链接是主题色而不是 Leaflet 默认蓝', { timeout: 60000 }, async () => {
  const page = await openPage();
  await page.evaluate(() => document.getElementById('sidebarToggle').click());
  await page.evaluate(() => document.querySelector('.sidebar-item').click());
  await page.waitForSelector('.poi-location', { timeout: 15000 });
  const s = await page.evaluate(() => ({
    location: document.querySelector('.poi-location').textContent,
    linkColor: getComputedStyle(document.querySelector('.visit-link')).color,
  }));
  assert.match(s.location, /📍 .+/);
  assert.strictEqual(s.linkColor, 'rgb(168, 79, 31)'); // --primary-hover;曾被 .leaflet-container a 的默认蓝压住
  await page.close();
});

test('地区筛选: 镜头重新取景,地图与统计行一致', { timeout: 60000 }, async () => {
  const page = await openPage();
  const zoomBefore = await page.evaluate(() => window.__foodmap.map.getZoom());
  await page.evaluate(() => {
    const sel = document.getElementById('continentSelect');
    sel.value = '欧洲';
    sel.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => /欧洲/.test(document.getElementById('stat').textContent), { timeout: 10000 });
  await sleep(2500); // flyTo 动画
  const s = await page.evaluate(() => ({
    zoom: window.__foodmap.map.getZoom(),
    statCount: Number(document.getElementById('stat').textContent.match(/^(\d+) 家/)[1]),
    mapCount:
      [...document.querySelectorAll('.cluster-pin')].reduce((n, el) => n + Number(el.textContent), 0) +
      document.querySelectorAll('.food-pin').length,
  }));
  assert.ok(s.zoom > zoomBefore, `筛选后应放大取景到欧洲(${zoomBefore} -> ${s.zoom})`);
  assert.strictEqual(s.mapCount, s.statCount, '地图上的点数应等于统计行的家数');
  await page.close();
});

test('搜索: 驱动地图图层而不只是侧栏列表', { timeout: 60000 }, async () => {
  const page = await openPage();
  await page.evaluate(() => {
    document.getElementById('sidebarToggle').click();
    const s = document.getElementById('sidebarSearch');
    s.value = '牛肉';
    s.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => /搜索/.test(document.getElementById('stat').textContent), { timeout: 10000 });
  const s = await page.evaluate(() => ({
    stat: document.getElementById('stat').textContent,
    listCount: document.querySelectorAll('.sidebar-item').length,
    mapCount:
      [...document.querySelectorAll('.cluster-pin')].reduce((n, el) => n + Number(el.textContent), 0) +
      document.querySelectorAll('.food-pin').length,
    statCount: Number(document.getElementById('stat').textContent.match(/^(\d+) 家/)[1]),
  }));
  assert.match(s.stat, /搜索"牛肉"/);
  assert.strictEqual(s.mapCount, s.statCount, '搜索后地图图层要跟着缩');
  assert.strictEqual(s.listCount, s.statCount, '侧栏列表与统计行一致');
  await page.close();
});

test('空筛选集: 回放拒绝进入并给出提示,清除筛选一键复位', { timeout: 60000 }, async () => {
  const page = await openPage();
  const fullStat = await page.evaluate(() => document.getElementById('stat').textContent);
  let alertMsg = null;
  page.on('dialog', async d => {
    alertMsg = d.message();
    await d.dismiss();
  });
  await page.evaluate(() => {
    const sel = document.getElementById('continentSelect');
    sel.value = '欧洲';
    sel.dispatchEvent(new Event('change'));
    const f = document.getElementById('yearFrom'),
      t = document.getElementById('yearTo');
    f.value = '2011';
    f.dispatchEvent(new Event('input'));
    t.value = '2011';
    t.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => /^0 家/.test(document.getElementById('stat').textContent), { timeout: 10000 });
  await page.evaluate(() => document.querySelector('.journey-btn').click());
  await sleep(400);
  const entered = await page.evaluate(() => document.querySelector('.journey-btn').classList.contains('active'));
  assert.strictEqual(entered, false, '0 个点不该进回放模式(曾抛 Bounds are not valid)');
  assert.match(String(alertMsg), /不足两次拜访/);
  // 侧栏空态的"清除筛选"一键复位
  await page.evaluate(() => {
    document.getElementById('sidebarToggle').click();
    document.querySelector('.clear-filters').click();
  });
  await page.waitForFunction(
    full => document.getElementById('stat').textContent === full,
    { timeout: 10000 },
    fullStat
  );
  await page.close();
});

test('回放中点侧栏: 退出回放并聚焦弹窗,而不是静默无响应', { timeout: 60000 }, async () => {
  const page = await openPage();
  await page.evaluate(() => {
    document.querySelector('.journey-btn').click();
    document.getElementById('sidebarToggle').click();
  });
  await page.evaluate(() => document.querySelector('.sidebar-item').click());
  await page.waitForSelector('.leaflet-popup .poi-name', { timeout: 15000 });
  const s = await page.evaluate(() => ({
    journeyActive: document.querySelector('.journey-btn').classList.contains('active'),
    popupTitle: document.querySelector('.poi-name').textContent.trim(),
  }));
  assert.strictEqual(s.journeyActive, false, '点了具体的店就该退出回放去看它');
  assert.ok(s.popupTitle.length > 0);
  await page.close();
});

test('移动端: 初始取景不是世界条,点列表项后侧栏让位给弹窗', { timeout: 60000 }, async () => {
  const page = await openPage({ mobile: true });
  const zoom = await page.evaluate(() => window.__foodmap.map.getZoom());
  assert.ok(zoom >= 3, `390px 宽初始 zoom 应 >= 3(世界条是 zoom 1),实际 ${zoom}`);
  await page.evaluate(() => document.getElementById('sidebarToggle').click());
  await page.evaluate(() => document.querySelector('.sidebar-item').click());
  await page.waitForSelector('.leaflet-popup .poi-name', { timeout: 15000 });
  const s = await page.evaluate(() => ({
    sidebarCollapsed: document.getElementById('sidebar').classList.contains('collapsed'),
    popupVisible: !!document.querySelector('.leaflet-popup'),
  }));
  assert.strictEqual(s.sidebarCollapsed, true, '窄屏侧栏不收起的话弹窗会整个被盖住');
  assert.strictEqual(s.popupVisible, true);
  await page.close();
});

test('全程零未捕获异常', () => {
  assert.deepStrictEqual(pageErrors, []);
});
