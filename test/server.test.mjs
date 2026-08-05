import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { resolveRequest, MIME } from '../server.mjs';

test('resolveRequest: 根路径映射到 index.html', () => {
  const r = resolveRequest('/');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(path.basename(r.file), 'index.html');
});

test('resolveRequest: 畸形百分号编码返回 400 而不是抛错', () => {
  // 之前 decodeURIComponent 直接抛 URIError,在 request handler 里等于未捕获
  // 异常,一个 `curl 'http://host/%zz'` 就能让整个 server 进程退出
  assert.doesNotThrow(() => resolveRequest('/%zz'));
  assert.strictEqual(resolveRequest('/%zz').status, 400);
  assert.strictEqual(resolveRequest('/%').status, 400);
  assert.strictEqual(resolveRequest('/%E4%B8').status, 400); // 截断的 UTF-8 序列
});

test('resolveRequest: 含 NUL 字节的路径返回 400', () => {
  assert.strictEqual(resolveRequest('/index.html%00.png').status, 400);
});

test('resolveRequest: 登录态/密钥/原始动态一律不放行', () => {
  // 这三个文件都在 .gitignore 里,但它们躺在仓库根目录,"把 ROOT 当静态根"
  // 会让它们照样从 HTTP 出去
  assert.strictEqual(resolveRequest('/cookies.json').status, 404);
  assert.strictEqual(resolveRequest('/ai-config.json').status, 404);
  assert.strictEqual(resolveRequest('/config.json').status, 404);
  assert.strictEqual(resolveRequest('/data/隋坡/posts_raw.json').status, 404);
  // 源码本身也没必要对外
  assert.strictEqual(resolveRequest('/server.mjs').status, 404);
  assert.strictEqual(resolveRequest('/package.json').status, 404);
});

test('resolveRequest: 地图页真正要读的路径放行', () => {
  assert.strictEqual(resolveRequest('/index.html').status, 200);
  assert.strictEqual(resolveRequest('/app.js').status, 200); // 前端逻辑抽出后的外链脚本
  assert.strictEqual(resolveRequest('/map-core.mjs').status, 200); // app.js import 的纯逻辑模块
  assert.strictEqual(resolveRequest('/data/bloggers.json').status, 200);
  assert.strictEqual(resolveRequest('/data/陈晓卿/restaurants.json').status, 200);
  assert.strictEqual(resolveRequest('/assets/continents.geojson').status, 200);
  assert.strictEqual(resolveRequest('/assets/food-icons/dumpling.png').status, 200);
  assert.strictEqual(resolveRequest('/assets/favicon.svg').status, 200);
});

test('resolveRequest: 百分号编码的中文博主名正常放行', () => {
  const r = resolveRequest('/data/%E9%99%88%E6%99%93%E5%8D%BF/restaurants.json');
  assert.strictEqual(r.status, 200);
  assert.ok(r.file.endsWith(path.join('data', '陈晓卿', 'restaurants.json')));
});

test('resolveRequest: 任何形式的目录穿越都出不去仓库', () => {
  // 之前的守卫是 `filePath.startsWith(ROOT)`,ROOT 末尾没有分隔符,
  // 兄弟目录 <父目录>/foodmap-secret/ 能通过前缀比较
  assert.strictEqual(resolveRequest('/../foodmap-secret/x.json').status, 404);
  assert.strictEqual(resolveRequest('/../../etc/passwd').status, 404);
  assert.strictEqual(resolveRequest('/assets/../cookies.json').status, 404);
  assert.strictEqual(resolveRequest('/%2e%2e/cookies.json').status, 404);
  assert.strictEqual(resolveRequest('/data/../../foodmap/cookies.json').status, 404);
  for (const p of ['/../foodmap-secret/x.json', '/assets/../cookies.json']) {
    assert.strictEqual(resolveRequest(p).file, undefined);
  }
});

test('resolveRequest: data 目录只放行 bloggers.json 和 restaurants.json', () => {
  assert.strictEqual(resolveRequest('/data/').status, 404);
  assert.strictEqual(resolveRequest('/data/陈晓卿/').status, 404);
  assert.strictEqual(resolveRequest('/data/陈晓卿/notes.json').status, 404);
  assert.strictEqual(resolveRequest('/data/陈晓卿/restaurants.json/x').status, 404);
});

test('MIME: svg 和 geojson 有正确的 Content-Type', () => {
  // 缺 .svg 时 favicon 以 application/octet-stream 下发,本地 server 上
  // 标签页图标不显示(GitHub Pages 自己认扩展名,所以只影响本地这条路)
  assert.strictEqual(MIME['.svg'], 'image/svg+xml');
  assert.match(MIME['.mjs'], /javascript/); // module script 有严格 MIME 校验,octet-stream 会被浏览器拒绝执行
  assert.match(MIME['.geojson'], /json/);
});
