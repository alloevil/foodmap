// 从带位置标记的微博动态里,批量抽取"是否为餐馆/推荐菜品"的纯逻辑
// (prompt 构造、LLM 输出解析、按餐厅名聚合去重)。不含网络 IO,便于单测。
//
// 输出协议选用管道分隔的行式文本而非 JSON:同类项目(qa-agent 的话题块标注)
// 已验证过,聊天/社交文本常带引号、换行,让模型生成合法转义的 JSON 数组
// 很容易出错;行式协议只需按行 split('|'),即使某个字段里偶然出现多余的
// "|" 也能靠"前 4 段是索引/餐厅名/城市/菜品,剩余全部拼回摘要"的方式兜底解析。

// 模型表达"这条看不出是哪家店"的几种写法。注意它经常不是干干净净一个"无",
// 而是"无(路边店未提名)"这种带括号补充的形式,所以判定要走
// isNotRestaurantName 而不是直接查这个集合。
const NOT_RESTAURANT = new Set(['无', 'none', '', 'null', '未知', '不详', '店名不明', '不明']);

// 菜品字段的占位写法。模型被要求"不确定菜品可留空",但它有时会填一个"无",
// 直接收下的话侧栏会渲染出一个写着"无"的菜品标签。
const NOT_DISH = new Set(['无', 'none', 'null', '未提及', '不详', '暂无', '未知', '无特别推荐']);

// 同一家店的不同写法,坐标应当几乎重合。超过这个距离就认为是不同的店
// (典型情况是同品牌的不同分店),不合并。
const ALIAS_MAX_DISTANCE_KM = 0.5;

/**
 * 餐厅名是否其实是"识别不出店名"。
 *
 * 只做全等比较会漏掉一大类:模型说不出店名时喜欢带个括号补充说明,
 * "无(路边店未提名)"、"无（小爆肚店）" 都会被当成真店名收进最终数据,
 * 在地图上留下一串名叫"无(...)"的假餐厅。
 *
 * 反过来也不能按"以无开头"一刀切——"无双"、"无名鱼馆"、"无名麦饼店" 是真
 * 店名;"无名小店(硚口四医院背后)" 是拿地标给无招牌小店起的名字,剥掉括号
 * 后核心是"无名小店",同样该保留。所以只剥掉末尾的括号补充再比对。
 */
export function isNotRestaurantName(name) {
  const raw = String(name || '').trim();
  if (NOT_RESTAURANT.has(raw.toLowerCase())) return true;
  const core = raw.replace(/[(（][^)）]*[)）]\s*$/, '').trim();
  return NOT_RESTAURANT.has(core.toLowerCase());
}

/**
 * 一个餐厅名字段里塞了多家店时拆开。模型会把一晚上连吃的几家写成
 * "富苑宵夜,老四手捶牛丸,田记猪血汤"——它们是不同的店,当成一家的话
 * 地图上只剩一个点、名字还长得读不下去。
 *
 * 分隔符只取逗号和分号:中文店名里几乎不会出现,而顿号要留给菜品列表。
 * 英文店名理论上可能自带逗号("Bar, Restaurant"),这是这个协议换不来
 * 更好办法的代价。
 */
export function splitRestaurantNames(name) {
  return String(name || '')
    .split(/[,，;；]/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** 去掉菜品里的占位写法("无"之类),顺带去空白/去重。 */
export function cleanDishes(dishes) {
  const seen = new Set();
  const out = [];
  for (const d of dishes || []) {
    const v = String(d).trim();
    if (!v || NOT_DISH.has(v.toLowerCase())) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** 单条候选动态 → 送入 LLM 的文本片段(截断,附加签到卡片提示)。 */
export function buildCandidateText(post, maxLen = 400) {
  const hint = post.checkinTitle ? `[签到:${post.checkinTitle}] ` : '';
  const text = (post.textRaw || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
  return hint + text;
}

export function buildExtractionPrompt(candidateTexts) {
  const list = candidateTexts.map((t, i) => `【${i}】${t}`).join('\n');
  return `以下是美食博主的 ${candidateTexts.length} 条带地理位置的微博动态。请判断每条是否在描述一次具体的餐馆/店铺就餐体验,如果是,提取餐厅名称、文字里明确提到的城市(比如"上海探店""成都本地小馆"里的上海/成都;没提到具体城市就留空,不要瞎猜)、以及提到的推荐菜品;如果不是(比如只是路过、谈论别的话题、看不出具体餐厅名),餐厅名填"无"。

${list}

输出格式:每条一行,格式为"编号|餐厅名|城市|菜品1,菜品2|一句话引用或概括(不确定菜品可留空,但尽量给出简短摘要)"。不要输出其他文字。例如:
0|又益轩|桂林|马肉米粉|离开桂林前在又益轩吃了马肉米粉，这种传统米粉已经好多年没吃过了
1|无|||

补充约定:
- 看不出具体店名就老实填"无",不要写成"无(路边小店)"这种带括号说明的形式。
- 没提到菜品就把菜品字段留空,不要填"无"。
- 一条动态里连吃了几家店,就把几个店名用英文逗号分隔写在餐厅名字段里(如"富苑宵夜,田记猪血汤")。`;
}

/**
 * 解析 LLM 行式输出。返回长度为 expectedCount 的数组,每项:
 *   { name, city, dishes: string[], quote } 或 null(非餐馆/解析失败)。
 *
 * 字段数下限是 3(餐厅名|城市|菜品):模型经常把末尾那段"引用/概括"整个省掉,
 * 之前要求满 4 段,这类完全合法的输出会被当成解析失败、连店名带菜品一起丢掉,
 * 而且还被计进"非餐馆/跳过"的统计里,日志上根本看不出丢了东西。下限不再往
 * 下放到 2,是因为 3 段起才足以把模型偶尔多写的散文行(通常不带两个"|")挡在外面。
 */
export function parseExtractionResponse(text, expectedCount) {
  const out = new Array(expectedCount).fill(null);
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(\d+)\s*\|(.*)$/);
    if (!m) continue;
    const i = Number(m[1]);
    if (!(i >= 0 && i < expectedCount)) continue;
    const parts = m[2].split('|');
    if (parts.length < 3) continue;
    const name = (parts[0] || '').trim();
    if (isNotRestaurantName(name)) continue;
    const city = (parts[1] || '').trim() || null;
    const dishes = cleanDishes((parts[2] || '').split(/[,，、]/));
    const quote = parts.slice(3).join('|').trim();
    out[i] = { name, city, dishes, quote };
  }
  return out;
}

/** 餐厅名归一化(去空白/统一大小写),仅用于聚合去重的比较键。 */
function normalizeName(name) {
  return name.replace(/\s+/g, '').toLowerCase();
}

/** 众数(出现次数最多的取值);全为空/无输入时返回 null。 */
function mode(values) {
  const counts = new Map();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = null,
    bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/** 两点球面距离(公里);任一坐标缺失返回 null。 */
function distanceKm(a, b) {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * 把同一家店的不同写法合并成一条:"甘家口柴氏" / "甘家口柴氏牛肉面"、
 * "汪姐" / "汪姐家"、"有礼有面" / "有礼有面四道口分店"。
 *
 * 光看名称包含关系合并是危险的:"大董" 和 "大董金宝汇店" 名字也是包含关系,
 * 但它们是同品牌的不同分店、坐标差十几公里,合并等于把地图上两个真实存在的
 * 点吞成一个。所以这里额外要求两点距离在 ALIAS_MAX_DISTANCE_KM 之内——名字
 * 一个是另一个的子串、位置又几乎重合,才认定是同一家店的不同写法。
 *
 * 一个字的名字不参与匹配:"面""记""董"这类单字会跟一大堆店名撞出假匹配。
 *
 * 每组保留名字最长(信息最全)的那条当代表,拜访记录合并后按时间重排。
 */
export function mergeNearbyAliases(entries) {
  const parent = entries.map((_, i) => i);
  const find = i => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const keys = entries.map(e => normalizeName(e.name));

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [short, long] = keys[i].length <= keys[j].length ? [keys[i], keys[j]] : [keys[j], keys[i]];
      if (short.length < 2 || !long.includes(short)) continue;
      const d = distanceKm(entries[i], entries[j]);
      if (d == null || d > ALIAS_MAX_DISTANCE_KM) continue;
      const ri = find(i),
        rj = find(j);
      if (ri !== rj) parent[rj] = ri;
    }
  }

  const groups = new Map();
  entries.forEach((e, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(e);
  });

  const out = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const rep = group.reduce(
      (best, e) => (normalizeName(e.name).length > normalizeName(best.name).length ? e : best),
      group[0]
    );
    const visits = [];
    const seenPosts = new Set();
    for (const e of group) {
      for (const v of e.visits) {
        const key = v.postId ?? `${v.date}|${v.quote}`;
        if (seenPosts.has(key)) continue;
        seenPosts.add(key);
        visits.push(v);
      }
    }
    visits.sort((a, b) => Date.parse(a.date || 0) - Date.parse(b.date || 0));
    out.push({ ...rep, visits });
  }
  return out;
}

/**
 * 聚合前先把"一个字段塞了多家店"的记录拆开,并丢掉识别不出店名的记录。
 * 拆出来的每家店共享这次外出的坐标和引用,但菜品不再分配到任何一家——
 * 原始输出没说清"哪道菜是哪家的",硬摊给每一家等于给每家都编造几道菜。
 */
function expandItems(extracted) {
  const out = [];
  for (const item of extracted) {
    if (isNotRestaurantName(item.name)) continue;
    const names = splitRestaurantNames(item.name);
    if (names.length === 0) continue;
    if (names.length === 1) {
      out.push({ ...item, name: names[0], dishes: cleanDishes(item.dishes) });
      continue;
    }
    for (const name of names) out.push({ ...item, name, dishes: [] });
  }
  return out;
}

/**
 * 按餐厅名聚合多次拜访。入参每项需含 { name, dishes, quote, geo, createdAt, postUrl, postId, regionName }。
 * geo 缺失的候选仍会被收录(dishes/quote 有价值),但不参与地图落点——
 * 由调用方决定是否过滤掉 lat/lng 为 null 的结果。
 */
export function aggregateRestaurants(extracted) {
  const byKey = new Map();
  for (const item of expandItems(extracted)) {
    const key = normalizeName(item.name);
    if (!byKey.has(key)) {
      byKey.set(key, {
        name: item.name, // 保留首次出现的原始写法作为展示名
        lat: item.geo?.lat ?? null,
        lng: item.geo?.lng ?? null,
        visits: [],
        _regions: [], // 临时字段,聚合完后折叠成 region 并删除
        _cityHints: [], // 临时字段,聚合完后折叠成 cityHint 并删除
      });
    }
    const entry = byKey.get(key);
    if (entry.lat == null && item.geo) {
      entry.lat = item.geo.lat;
      entry.lng = item.geo.lng;
    }
    entry._regions.push(item.regionName || null);
    entry._cityHints.push(item.city || null);
    entry.visits.push({
      date: item.createdAt,
      postId: item.postId,
      postUrl: item.postUrl,
      dishes: item.dishes,
      quote: item.quote,
    });
  }
  // 每家餐厅按拜访时间升序排列,便于地图卡片展示"第一次/最近一次"
  for (const r of byKey.values()) {
    r.visits.sort((a, b) => Date.parse(a.date || 0) - Date.parse(b.date || 0));
    // 微博的 region_name 是发帖时的 IP 归属地(粗粒度),同一家店多次拜访
    // 偶尔会因为发帖设备/网络环境不同而不一致,取众数作为该店的代表地区,
    // 供"按地区筛选"用——不是精确地址。
    r.region = mode(r._regions);
    delete r._regions;
    // cityHint 是 LLM 从文字里读出来的城市(比如"探店成都xx"里的成都),
    // 跟上面的 region 是两回事:region 是发帖时人在哪(IP),cityHint 是
    // 文字描述的餐厅实际所在城市。按名称正向搜索坐标(geocode-regions.mjs
    // 的 forwardGeocodeByName)时应该优先用 cityHint,不然博主人在北京却
    // 探店成都,用 IP 归属地"北京"当搜索线索会系统性地搜偏。
    r.cityHint = mode(r._cityHints);
    delete r._cityHints;
  }
  // 名称完全一致的已经并完了,最后再收一遍"同一家店的不同写法"
  return mergeNearbyAliases([...byKey.values()]);
}
