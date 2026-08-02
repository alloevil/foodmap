import { test } from 'node:test';
import assert from 'node:assert';
import { buildCandidateText, buildExtractionPrompt, parseExtractionResponse, aggregateRestaurants, isNotRestaurantName, splitRestaurantNames, cleanDishes, mergeNearbyAliases } from '../extract.mjs';

test('buildCandidateText: 附加签到提示,截断超长文本,压平换行', () => {
  const t = buildCandidateText({ textRaw: '在\n星冈\n吃了午餐', checkinTitle: null });
  assert.strictEqual(t, '在 星冈 吃了午餐');
  const withHint = buildCandidateText({ textRaw: '很晚的晚餐', checkinTitle: '桂花公社景区' });
  assert.strictEqual(withHint, '[签到:桂花公社景区] 很晚的晚餐');
  const long = buildCandidateText({ textRaw: 'x'.repeat(500) }, 50);
  assert.strictEqual(long.length, 50);
});

test('buildExtractionPrompt: 按编号列出候选文本', () => {
  const p = buildExtractionPrompt(['吃了米粉', '路过桂林']);
  assert.match(p, /【0】吃了米粉/);
  assert.match(p, /【1】路过桂林/);
  assert.match(p, /编号\|餐厅名\|城市\|菜品/);
});

test('parseExtractionResponse: 正常解析餐厅名/城市/菜品/摘要', () => {
  const out = parseExtractionResponse(
    '0|又益轩|桂林|马肉米粉|离开桂林前吃了马肉米粉\n1|无|||',
    2
  );
  assert.deepStrictEqual(out[0], { name: '又益轩', city: '桂林', dishes: ['马肉米粉'], quote: '离开桂林前吃了马肉米粉' });
  assert.strictEqual(out[1], null);
});

test('parseExtractionResponse: 没提到具体城市时 city 为 null', () => {
  const out = parseExtractionResponse('0|星冈||生蚝|好吃', 1);
  assert.strictEqual(out[0].city, null);
});

test('parseExtractionResponse: 餐厅名"无"(不分大小写)判定为非餐馆', () => {
  const out = parseExtractionResponse('0|无|||\n1|None|||\n2|NULL|||', 3);
  assert.deepStrictEqual(out, [null, null, null]);
});

test('parseExtractionResponse: 摘要里意外出现的竖线被拼回摘要而不截断', () => {
  const out = parseExtractionResponse('0|星冈|北京|生蚝,和牛|老板说 A|B 两个套餐都不错', 1);
  assert.strictEqual(out[0].quote, '老板说 A|B 两个套餐都不错');
});

test('parseExtractionResponse: 越界编号/格式错误行忽略,不抛错', () => {
  const out = parseExtractionResponse('9|越界|||\n完全没有格式\n0|星冈|北京|生蚝|好吃', 1);
  assert.strictEqual(out[0].name, '星冈');
});

test('aggregateRestaurants: 同名餐厅合并为一条,多次拜访按时间升序', () => {
  const extracted = [
    { name: '星冈', city: '北京', dishes: ['生蚝'], quote: '第一次', geo: { lat: 39.9, lng: 116.4 }, createdAt: 'Thu Jul 10 2026', postId: 1, postUrl: 'u1', regionName: '北京' },
    { name: ' 星冈 ', city: '北京', dishes: ['和牛'], quote: '第二次', geo: null, createdAt: 'Thu Jul 20 2026', postId: 2, postUrl: 'u2', regionName: '北京' },
    { name: '又益轩', city: '桂林', dishes: ['马肉米粉'], quote: '桂林', geo: { lat: 25.3, lng: 110.3 }, createdAt: 'Thu Jul 05 2026', postId: 3, postUrl: 'u3', regionName: '广西' },
  ];
  const r = aggregateRestaurants(extracted);
  assert.strictEqual(r.length, 2);
  const xingang = r.find(x => x.name === '星冈');
  assert.strictEqual(xingang.visits.length, 2);
  assert.strictEqual(xingang.lat, 39.9); // 沿用首次出现时的坐标
  assert.strictEqual(xingang.visits[0].quote, '第一次'); // 时间升序
  assert.strictEqual(xingang.visits[1].quote, '第二次');
  assert.strictEqual(xingang.region, '北京');
  assert.strictEqual(r.find(x => x.name === '又益轩').region, '广西');
});

test('aggregateRestaurants: cityHint 取文字里提到城市的众数,跟 region(IP归属地)是两个独立字段', () => {
  const r = aggregateRestaurants([
    // 博主发帖 IP 在北京(region),但文字里写的是在成都探店(cityHint)——
    // 按名称搜索坐标时应该用成都而不是北京,不然会系统性地搜偏
    { name: '老字号', city: '成都', dishes: [], quote: 'a', geo: null, createdAt: 't1', postId: 1, postUrl: 'u1', regionName: '北京' },
    { name: '老字号', city: '成都', dishes: [], quote: 'b', geo: null, createdAt: 't2', postId: 2, postUrl: 'u2', regionName: '北京' },
  ]);
  assert.strictEqual(r[0].region, '北京');
  assert.strictEqual(r[0].cityHint, '成都');
});

test('aggregateRestaurants: city 缺失(LLM 没读出具体城市)时 cityHint 为 null', () => {
  const r = aggregateRestaurants([{ name: 'Y', city: null, dishes: [], quote: 'q', geo: null, createdAt: 't', postId: 1, postUrl: 'u', regionName: '上海' }]);
  assert.strictEqual(r[0].cityHint, null);
});

test('aggregateRestaurants: region 取众数,不一致时以出现次数最多的为准', () => {
  const r = aggregateRestaurants([
    { name: 'X', dishes: [], quote: 'a', geo: { lat: 1, lng: 1 }, createdAt: 't1', postId: 1, postUrl: 'u1', regionName: '广东' },
    { name: 'X', dishes: [], quote: 'b', geo: { lat: 1, lng: 1 }, createdAt: 't2', postId: 2, postUrl: 'u2', regionName: '广东' },
    { name: 'X', dishes: [], quote: 'c', geo: { lat: 1, lng: 1 }, createdAt: 't3', postId: 3, postUrl: 'u3', regionName: '海外' },
  ]);
  assert.strictEqual(r[0].region, '广东');
});

test('aggregateRestaurants: regionName 缺失不报错,region 为 null', () => {
  const r = aggregateRestaurants([{ name: 'Y', dishes: [], quote: 'q', geo: null, createdAt: 't', postId: 1, postUrl: 'u' }]);
  assert.strictEqual(r[0].region, null);
});

test('aggregateRestaurants: 无 geo 的候选也保留在结果里(由调用方决定是否上图)', () => {
  const r = aggregateRestaurants([{ name: 'X', dishes: [], quote: 'q', geo: null, createdAt: 't', postId: 1, postUrl: 'u' }]);
  assert.strictEqual(r[0].lat, null);
});

test('isNotRestaurantName: 带括号补充的"无"也算识别不出店名', () => {
  // 模型说不出店名时爱带个括号解释一下,之前只做全等比较,这类回答全都
  // 当成真店名收进了最终数据,地图上留下一串名叫"无(...)"的假餐厅
  for (const n of ['无', '无(路边店未提名)', '无（小爆肚店）', '无（顺德农家菜馆）', 'none', 'NULL', '不详', '']) {
    assert.strictEqual(isNotRestaurantName(n), true, n);
  }
});

test('isNotRestaurantName: "无"开头的真店名不能被误杀', () => {
  // 不能按前缀一刀切:这些都是真实存在的店名,"无名小店(硚口四医院背后)"
  // 是拿地标给无招牌小店起的名字,剥掉括号后核心是"无名小店",同样保留
  for (const n of ['无双', '无名鱼馆', '无名面馆', '无名麦饼店', '无名小店(硚口四医院背后)', '嘉里中心烧鸟(店名不明)']) {
    assert.strictEqual(isNotRestaurantName(n), false, n);
  }
});

test('splitRestaurantNames: 逗号/分号分隔的多家店拆开,顿号不拆', () => {
  assert.deepStrictEqual(splitRestaurantNames('富苑宵夜,老四手捶牛丸,田记猪血汤'), ['富苑宵夜', '老四手捶牛丸', '田记猪血汤']);
  assert.deepStrictEqual(splitRestaurantNames('高乐园;无名河南胡辣汤店'), ['高乐园', '无名河南胡辣汤店']);
  assert.deepStrictEqual(splitRestaurantNames('The taco bar,野风筝,小七'), ['The taco bar', '野风筝', '小七']);
  assert.deepStrictEqual(splitRestaurantNames('又益轩'), ['又益轩']);
  // 顿号留给菜品列表,店名不按它拆
  assert.deepStrictEqual(splitRestaurantNames('张三、李四饭馆'), ['张三、李四饭馆']);
});

test('cleanDishes: 剔除"无"这类占位菜品并去重', () => {
  assert.deepStrictEqual(cleanDishes(['无']), []);
  assert.deepStrictEqual(cleanDishes([' 生蚝 ', '无', '生蚝', '', '未提及', '和牛']), ['生蚝', '和牛']);
});

test('parseExtractionResponse: 模型省掉末尾的引用字段也照样解析(quote 为空)', () => {
  // 之前要求满 4 段,模型把"引用/概括"整个省掉时这条完全合法的输出会被
  // 当成解析失败丢掉,还被计进"非餐馆/跳过"的统计,日志上看不出丢了东西
  const out = parseExtractionResponse('0|又益轩|桂林|马肉米粉', 1);
  assert.deepStrictEqual(out[0], { name: '又益轩', city: '桂林', dishes: ['马肉米粉'], quote: '' });
});

test('parseExtractionResponse: 散文行(不足 3 段)仍然被挡在外面', () => {
  assert.deepStrictEqual(parseExtractionResponse('0|以下是提取结果\n0|好的', 1), [null]);
});

test('parseExtractionResponse: 菜品字段填"无"时不产生菜品标签', () => {
  const out = parseExtractionResponse('0|猪肉婆|顺德|无|不错', 1);
  assert.deepStrictEqual(out[0].dishes, []);
});

test('aggregateRestaurants: 一条动态里的多家店拆成多条(菜品不硬摊给其中任何一家)', () => {
  const r = aggregateRestaurants([
    { name: '富苑宵夜,田记猪血汤', city: '汕头', dishes: ['牛肉丸', '猪血汤'], quote: '汕头夜宵连吃两家', geo: { lat: 23.35, lng: 116.68 }, createdAt: 'Thu Jul 10 2026', postId: 1, postUrl: 'u1', regionName: '广东' },
  ]);
  assert.deepStrictEqual(r.map(x => x.name).sort(), ['富苑宵夜', '田记猪血汤']);
  // 原始输出没说清哪道菜是哪家的,给每家都挂上两道菜等于编造
  for (const x of r) {
    assert.deepStrictEqual(x.visits[0].dishes, []);
    assert.strictEqual(x.visits[0].quote, '汕头夜宵连吃两家');
    assert.strictEqual(x.lat, 23.35);
  }
});

test('aggregateRestaurants: 识别不出店名的记录不进结果', () => {
  const r = aggregateRestaurants([
    { name: '无(路边店未提名)', dishes: [], quote: 'q', geo: { lat: 1, lng: 1 }, createdAt: 't', postId: 1, postUrl: 'u' },
    { name: '又益轩', dishes: [], quote: 'q', geo: { lat: 25.3, lng: 110.3 }, createdAt: 't', postId: 2, postUrl: 'u' },
  ]);
  assert.deepStrictEqual(r.map(x => x.name), ['又益轩']);
});

test('mergeNearbyAliases: 同名包含且坐标几乎重合的合并成一条,保留信息最全的名字', () => {
  const merged = mergeNearbyAliases([
    { name: '柴氏', lat: 39.9301, lng: 116.3201, visits: [{ date: 'Thu Jul 10 2026', postId: 1, dishes: [], quote: 'a' }] },
    { name: '甘家口柴氏牛肉面', lat: 39.93, lng: 116.32, visits: [{ date: 'Thu Jul 05 2026', postId: 2, dishes: [], quote: 'b' }] },
  ]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].name, '甘家口柴氏牛肉面');
  assert.deepStrictEqual(merged[0].visits.map(v => v.quote), ['b', 'a']); // 合并后按时间重排
});

test('mergeNearbyAliases: 同品牌不同分店(坐标差得远)不合并', () => {
  // "大董" 和 "大董金宝汇店" 名字是包含关系,但是地图上两个真实存在的点,
  // 只按名称合并会把其中一个吞掉
  const merged = mergeNearbyAliases([
    { name: '大董', lat: 39.9388, lng: 116.4553, visits: [{ date: 't1', postId: 1, dishes: [], quote: 'a' }] },
    { name: '大董金宝汇店', lat: 39.9088, lng: 116.4074, visits: [{ date: 't2', postId: 2, dishes: [], quote: 'b' }] },
  ]);
  assert.strictEqual(merged.length, 2);
});

test('mergeNearbyAliases: 单字名不参与匹配,坐标缺失的不合并', () => {
  const merged = mergeNearbyAliases([
    { name: '面', lat: 39.93, lng: 116.32, visits: [] },
    { name: '甘家口柴氏牛肉面', lat: 39.93, lng: 116.32, visits: [] },
    { name: '柴氏', lat: null, lng: null, visits: [] },
  ]);
  assert.strictEqual(merged.length, 3);
});

test('mergeNearbyAliases: 三条链式包含关系并成一组', () => {
  const merged = mergeNearbyAliases([
    { name: '柴氏', lat: 39.93, lng: 116.32, visits: [{ date: 't1', postId: 1, dishes: [], quote: 'a' }] },
    { name: '甘家口柴氏', lat: 39.9301, lng: 116.3201, visits: [{ date: 't2', postId: 2, dishes: [], quote: 'b' }] },
    { name: '甘家口柴氏牛肉面', lat: 39.9302, lng: 116.3202, visits: [{ date: 't3', postId: 3, dishes: [], quote: 'c' }] },
  ]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].name, '甘家口柴氏牛肉面');
  assert.strictEqual(merged[0].visits.length, 3);
});
