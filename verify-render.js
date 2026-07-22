// 冒烟测试:用 Puppeteer 打开地图页,统计标记数量并截图,快速发现"页面空白"类回归。
// 用法: node verify-render.js [--name 陈晓卿] [--port 3457]
const puppeteer = require('puppeteer');
const { resolveChromePath } = require('./lib/chrome-path.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : d; };
const name = opt('name', '');
const port = opt('port', '3457');

(async () => {
  let configChromePath = '';
  try { configChromePath = require('./config.json').chromePath; } catch { /* 可缺省 */ }
  const browser = await puppeteer.launch({ headless: 'new', executablePath: resolveChromePath(configChromePath) });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const url = `http://localhost:${port}/` + (name ? '?name=' + encodeURIComponent(name) : '');
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
  await new Promise(r => setTimeout(r, 2000)); // 等 Leaflet 瓦片加载
  const markerCount = await page.evaluate(() => document.querySelectorAll('.leaflet-marker-icon, path.leaflet-interactive').length);
  const statText = await page.evaluate(() => document.getElementById('stat')?.textContent);
  console.log('地图上的标记/图形元素数量:', markerCount);
  console.log('统计文字:', statText);
  await page.screenshot({ path: '/tmp/foodmap-screenshot.png' });
  console.log('截图已存 /tmp/foodmap-screenshot.png');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
