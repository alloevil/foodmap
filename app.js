// 地图页的全部前端逻辑。曾内联在 index.html 里,抽出来的直接动机:
// 1) eslint 只认 *.js/*.mjs,内联的 1100+ 行 JS(全项目最大的一块代码)
//    一直游离在 no-undef/no-unused-vars 之外;
// 2) index.html 已经 1500+ 行,HTML/CSS/JS 三种语言挤一个文件,定位成本高。
// 仍是零构建:index.html 用普通 <script src="app.js"> 引入,GitHub Pages 行为不变。

const params = new URLSearchParams(location.search);
// 未指定 ?name= 时默认展示随仓库附带的示例数据(陈晓卿);其他博主的数据
// 需要你本地跑过 fetch-posts.mjs/extract-restaurants.mjs 后用 ?name=<博主名> 查看。
// ?name=all 是特殊值,表示合并 bloggers.json 里列出的所有博主一起看。
const DEFAULT_BLOGGER = '陈晓卿';
const bloggerName = params.get('name') || DEFAULT_BLOGGER;

// 与 extract-restaurants.mjs 的 dataDir() 保持一致的目录名清洗规则
function safeName(name) {
    return String(name).replace(/[^a-zA-Z0-9一-鿿]/g, '_');
}

// 纯静态站点没法"列目录"看有哪些博主的数据,只能维护一份清单文件——
// 加载失败(比如 fork 了仓库但还没建这个文件)就退化成只有当前博主一个
// 选项,不报错,下拉框本身也就没什么用但不影响地图正常显示。
async function loadBloggerList() {
    try {
        const resp = await fetch('data/bloggers.json');
        const list = await resp.json();
        return Array.isArray(list) && list.length ? list : [bloggerName];
    } catch {
        return [bloggerName];
    }
}

function setupBloggerSelect(allBloggers) {
    const sel = document.getElementById('bloggerSelect');
    // ?name= 传了一个还没进 bloggers.json 的名字时,原本没有对应的 option,
    // 下面那行 sel.value 赋值会落空、selectedIndex 变成 -1,下拉框整个显示成
    // 空白,看不出当前在看谁。把它当成一个临时选项补进去。
    const names =
        bloggerName === 'all' || allBloggers.includes(bloggerName) ? allBloggers : [bloggerName, ...allBloggers];
    sel.innerHTML =
        names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('') +
        '<option value="all">全部</option>';
    sel.value = bloggerName; // bloggerName 是 'all' 或某个具体名字,跟 option 的 value 对应
    sel.addEventListener('change', () => {
        location.search = '?name=' + encodeURIComponent(sel.value);
    });
}

// 暖色底图(CartoDB Voyager,免 API key;比纯灰的 Positron 更暖,契合美食主题)
const map = L.map('map', { zoomControl: false }).setView([34, 108], 5);
L.control.zoom({ position: 'topright' }).addTo(map); // 避免与左上角信息卡重叠
const baseLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 19,
    className: 'lively-tiles', // 纯 CSS 滤镜调色,不用额外的地图服务/API key
}).addTo(map);

// 跟踪瓦片是否加载完——轨迹回放跳到新区域时用得上(见 setupJourney 的
// waitForTiles):不能让车/飞机图标在瓦片还没画出来的空白/半空白底图上
// 就开始滑动,那样看起来像"漂浮在虚空里"
let tilesReady = true;
baseLayer.on('loading', () => {
    tilesReady = false;
});
baseLayer.on('load', () => {
    tilesReady = true;
});

// 滤镜强度跟着缩放层级走:洲/世界视图(zoom<=4)加到最猛,街道级
// (zoom>=12)减弱到不影响路名可读性,中间保持默认强度
function updateTileFilterTier() {
    const el = baseLayer.getContainer();
    if (!el) return;
    const z = map.getZoom();
    el.classList.remove('zoom-far', 'zoom-near');
    if (z <= 4) el.classList.add('zoom-far');
    else if (z >= 12) el.classList.add('zoom-near');
}
map.on('zoomend', updateTileFilterTier);
map.whenReady(updateTileFilterTier);

// 现有 location.continent 字段是中文(来自 geocode-regions.mjs),
// GeoJSON 边界数据里的 CONTINENT 属性是英文,这里做个映射
const CONTINENT_EN = {
    亚洲: 'Asia',
    欧洲: 'Europe',
    非洲: 'Africa',
    北美洲: 'North America',
    南美洲: 'South America',
    大洋洲: 'Oceania',
};

// 按洲涂色背景(choropleth):颜色深浅代表该洲拜访次数多少,跟区域/年份
// 筛选联动(见 setupFilters 的 apply() 末尾调用 choropleth.update())。
// 用 sqrt 而不是线性映射次数→透明度,是因为数据往往像陈晓卿这份一样
// 悬殊(亚洲 274 次、欧洲个位数)——线性映射会把小值的洲压得几乎看不见,
// sqrt 让"有一点"和"完全没有"之间的差异更看得出来。
function setupChoropleth(restaurants) {
    // 175 个国家轮廓(还带描边)默认走 SVG 渲染——回放移动/缩放时每一帧都要
    // 重新计算重绘这么多矢量路径,是拖慢移动/缩放体验的主要原因之一。换成
    // Canvas 渲染器:整块图层变成一张位图,缩放/平移时直接跟着变换,不用
    // 逐个路径重算,大量图形叠一起时通常比 SVG 明显跟得上手。
    const choroplethRenderer = L.canvas({ padding: 0.5 });
    const layer = L.geoJSON(null, {
        renderer: choroplethRenderer,
        interactive: false, // 不拦截点击/拖动,纯装饰性背景
        // 之前 color:transparent/weight:0 完全没描边,靠底图自带的那条很细的
        // 国界线透出来——填色不透明度一高就直接把那条线整个盖住,国家之间
        // 看起来糊成一片。改成自己描一条细边,不管填色多深,国家轮廓始终
        // 看得清,不用依赖底图那条容易被盖住的线。
        style: () => ({ color: 'rgba(43,33,24,.35)', weight: 0.7, fillColor: '#c1642a', fillOpacity: 0 }),
    }).addTo(map);
    let baseOpacity = new Map();

    fetch('assets/continents.geojson')
        .then(r => r.json())
        .then(data => {
            layer.addData(data);
            update(restaurants);
        })
        .catch(() => {}); // 纯装饰图层,拉取失败静默跳过,不影响地图核心功能

    // 缩到国家/街道级别时整块颜色会糊住大半个屏幕,反而干扰看细节——
    // 跟瓦片滤镜的三档思路一样,放大到 zoom 9 以上就淡出到完全透明
    function zoomFactor() {
        const z = map.getZoom();
        if (z <= 6) return 1;
        if (z >= 9) return 0;
        return 1 - (z - 6) / 3;
    }
    function applyOpacity() {
        const factor = zoomFactor();
        layer.eachLayer(l => {
            const base = baseOpacity.get(l.feature.properties.continent) || 0;
            l.setStyle({ fillOpacity: base * factor });
        });
    }
    map.on('zoomend', applyOpacity);

    function update(visibleRestaurants) {
        const counts = {};
        for (const r of visibleRestaurants) {
            const en = CONTINENT_EN[r.location && r.location.continent];
            if (!en) continue;
            counts[en] = (counts[en] || 0) + r.visits.length;
        }
        const max = Math.max(1, ...Object.values(counts));
        baseOpacity = new Map(Object.entries(counts).map(([en, c]) => [en, 0.06 + 0.5 * Math.sqrt(c / max)]));
        applyOpacity();
    }
    return { update };
}

// 侧栏顶部跟随信息卡的实际高度,而不是写死一个像素值——统计文字长度会变
// (比如年份筛选后的文案更长换行),写死的话卡片一变高就会和侧栏重叠。
// 折叠按钮同理:折叠态下它会挪到左上角(标题卡所在位置),top 也必须跟
// 标题卡一起动,否则标题卡一变高,折叠按钮就会被压在它上面。
const topbarEl = document.querySelector('.topbar');
const sidebarEl0 = document.getElementById('sidebar');
const sidebarToggleEl0 = document.getElementById('sidebarToggle');
function repositionSidebar() {
    const top = topbarEl.getBoundingClientRect().bottom + 12 + 'px';
    sidebarEl0.style.top = top;
    sidebarToggleEl0.style.top = top;
}
new ResizeObserver(repositionSidebar).observe(topbarEl);
repositionSidebar();

// "定位我"按钮:作为 Leaflet 控件加进 topright,会自动叠在缩放按钮下方,
// 不用手动算像素偏移。真正的定位逻辑在 load() 里数据备好之后才挂(见 onLocate)。
let onLocate = null;
const LocateControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
        const btn = L.DomUtil.create('button', 'locate-btn');
        btn.innerHTML = '📍';
        btn.title = '获取你的位置,按距离排序看附近有什么好吃的';
        btn.setAttribute('aria-label', btn.title);
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, 'click', () => onLocate && onLocate(btn));
        return btn;
    },
});
map.addControl(new LocateControl());

// "旅行轨迹"开关:同样是 topright 的 Leaflet 控件,自动排在定位按钮下方
let onToggleJourney = null;
const JourneyControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
        const btn = L.DomUtil.create('button', 'journey-btn');
        btn.innerHTML = '🧭';
        btn.title = '按时间顺序回放拜访路线';
        btn.setAttribute('aria-label', btn.title);
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, 'click', () => onToggleJourney && onToggleJourney(btn));
        return btn;
    },
});
map.addControl(new JourneyControl());

// 每次进入都用指向目标按钮的气泡提一下作用,避免光靠图标/文字被忽略。
// 之前用 localStorage 记住"看过了"只弹一次,但用户明确要求每次打开都弹,
// 所以去掉了那层记忆——气泡还是会在点击按钮或点气泡本身之后消失,只是
// 不再持久记住,下次刷新页面会重新出现。
//
// 一次只弹一个,不再三个同时挂在屏幕上:三个气泡一起弹视觉上互相抢,
// 移动端还会叠着压住标题卡。点掉当前这个才轮到下一个(queuePointerHints);
// 进入轨迹回放等"用户已经开始正经用了"的时刻直接清空整个队列
// (dismissAllHints)——都动手操作了还追着上课很烦人。
let activeHintDismiss = null;
let pendingHints = [];

function dismissAllHints() {
    pendingHints = [];
    if (activeHintDismiss) activeHintDismiss();
}

function queuePointerHints(hints, initialDelayMs = 1200) {
    pendingHints = hints.slice();
    const next = () => {
        const h = pendingHints.shift();
        if (h) showPointerHint(h, () => setTimeout(next, 350));
    };
    setTimeout(next, initialDelayMs);
}

function showPointerHint({ targetSelector, text, arrowLeft = false }, onDismissed) {
    const btn = document.querySelector(targetSelector);
    if (!btn) {
        if (onDismissed) onDismissed();
        return;
    }

    // 窄屏上按钮左侧/右侧都放不下 190px 的气泡(会压住标题卡,见移动端
    // 截图复盘),改挂在按钮正下方、箭头朝上
    const below = window.innerWidth <= 640;
    const hint = document.createElement('div');
    hint.className = 'pointer-hint' + (below ? ' arrow-up' : arrowLeft ? ' arrow-left' : '');
    hint.textContent = text;
    document.body.appendChild(hint);

    function position() {
        const rect = btn.getBoundingClientRect();
        if (below) {
            // 不高于标题卡下沿:定位/回放按钮在窄屏上跟标题卡几乎平行,
            // 只按按钮下沿摆会让气泡左端压住标题卡的右下角
            const topbar = document.querySelector('.topbar');
            const minTop = topbar ? topbar.getBoundingClientRect().bottom + 8 : 0;
            hint.style.top = Math.max(rect.bottom + 10, minTop) + 'px';
            // 箭头在气泡右端往里 14px 的位置(见 .arrow-up::after),让它
            // 对准按钮中心;整体再夹回视口内,不越出左右边缘
            const left = Math.max(
                8,
                Math.min(rect.left + rect.width / 2 - (hint.offsetWidth - 20), window.innerWidth - hint.offsetWidth - 8)
            );
            hint.style.left = left + 'px';
            hint.style.right = 'auto';
            return;
        }
        if (arrowLeft) {
            hint.style.left = rect.right + 10 + 'px';
            hint.style.right = 'auto';
        } else {
            hint.style.right = window.innerWidth - rect.left + 10 + 'px';
            hint.style.left = 'auto';
        }
        hint.style.top = rect.top + rect.height / 2 - hint.offsetHeight / 2 + 'px';
    }
    position();
    requestAnimationFrame(() => hint.classList.add('show'));
    window.addEventListener('resize', position);

    const dismiss = () => {
        if (activeHintDismiss === dismiss) activeHintDismiss = null;
        window.removeEventListener('resize', position);
        hint.classList.remove('show');
        setTimeout(() => hint.remove(), 300);
        if (onDismissed) onDismissed();
    };
    activeHintDismiss = dismiss;
    // 只在点了按钮(或气泡本身)之后才消失,不设自动超时——用户可能没
    // 第一时间注意到,给够时间看清楚提示在说什么
    btn.addEventListener('click', dismiss, { once: true });
    hint.addEventListener('click', dismiss);
}

function escapeHtml(s) {
    return String(s).replace(
        /[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
}

// 球面距离(公里),Haversine 公式,用于"附近好吃的"排序
function distanceKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function formatDistance(km) {
    return km < 1 ? `${Math.round(km * 1000)}m` : `${km.toFixed(km < 10 ? 1 : 0)}km`;
}

// 去空格再转小写——之前的搜索只做了小写转换,店名/查询词里偶尔有的
// 空格(全角/半角)会让本该命中的结果搜不到,比如"陈 记"搜"陈记"落空。
// 提到顶层是因为搜索现在同时驱动侧栏列表和地图图层(见 setupFilters 的
// apply()),两边必须用同一套匹配逻辑,不然会出现"列表里有、地图上没有"。
function normalizeSearchText(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/\s+/g, '');
}
// 店名搜不到时,再看看是不是搜的是某道推荐菜——数据里每次拜访都存了
// 菜品,搜"牛河"应该能翻出"利苑"这种店名完全不沾边的结果。命中就返回
// 那道菜的原文,用于在列表里标注"因为这道菜被搜到"。
function matchedDishOf(r, q) {
    for (const v of r.visits) {
        for (const d of v.dishes || []) {
            if (normalizeSearchText(d).includes(q)) return d;
        }
    }
    return null;
}
function matchesSearch(r, q) {
    if (!q) return true;
    return normalizeSearchText(r.name).includes(q) || !!matchedDishOf(r, q);
}

// 把镜头对到一组餐厅上。fitBounds 对"分布横跨三大洲"的数据在窄屏上会
// 缩到 zoom 1 的世界条——390px 宽的屏幕上地图只剩中间一细条,上下全是
// 空白画布(移动端截图复盘的主要观感问题)。缩得太远时改用数据的平均
// 中心 + 固定缩放:平均值天然偏向点最密的地方(两百多个点在中国),
// 落点就是"大多数餐厅在哪",边缘的欧美点让用户自己缩小去看。
function frameRestaurants(list) {
    const pts = list.filter(r => r.lat != null).map(r => [r.lat, r.lng]);
    if (!pts.length) return;
    map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 13 });
    if (window.innerWidth <= 640 && map.getZoom() < 2.5) {
        const lat = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const lng = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        map.setView([lat, lng], 3);
    }
}

function formatDate(raw) {
    // Date.parse 只认字符串——数字类型的时间戳传进来会先被强制转成字符串
    // (比如 "1784273990000"),不是合法的日期格式,直接判定 NaN 走进原样
    // 返回的兜底分支。数据新鲜度提示传的就是 Math.max(...timestamps) 算出
    // 来的数字,不特殊处理这里会直接把时间戳数字显示给用户看。
    const t = typeof raw === 'number' ? raw : Date.parse(raw);
    if (isNaN(t)) return raw || '';
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 按名称哈希挑一个食物 emoji,同一家餐厅在标记/侧栏/弹窗里始终显示同一个
// 图标——纯函数、不依赖任何状态,提到顶层后弹窗和侧栏可以直接调用,不用
// 再作为参数一路传下去。
// 图标本体是微软 Fluent Emoji 的 3D 渲染图(MIT 协议,存在 assets/food-icons/
// 下),不再是纯 emoji 文字——立体渲染质感跟之前给标记加的玻璃高光是同一个
// "让图标更有质感"的思路,只是这次换成真正的立体插画而不是 CSS 模拟。
const FOOD_ICONS = [
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
function pickFoodIcon(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % FOOD_ICONS.length;
    return FOOD_ICONS[h];
}
function foodIconImg(name, size) {
    return `<img class="food-icon-img" src="assets/food-icons/${pickFoodIcon(name)}.png" width="${size}" height="${size}" alt="">`;
}

// 常去的店(拜访 ≥2 次)弹窗一次性铺开全部历史会拖得很长,划半天才能看完。
// 默认只展示最近几次(visits 本来就按时间升序排好,取末尾几条就是最近的),
// 更早的收在一个可展开的区域里,点一下"展开全部"再看。
const POPUP_VISIT_COLLAPSE_THRESHOLD = 3;

function renderPopup(r) {
    const bloggerTag =
        isCombinedView && r._blogger ? `<span class="poi-blogger-tag">${escapeHtml(r._blogger)}</span>` : '';
    let html = `<div class="poi-name">${foodIconImg(r.name, 20)} ${escapeHtml(r.name)}${bloggerTag}</div>`;
    // 店在哪个城市:之前只有店名+拜访记录,位置要靠盯地图猜。国内显示
    // 省·市,国外显示国家·城市;没跑过地区反查的老数据退回 region
    // (发帖 IP 归属地,粗但聊胜于无)。
    const loc = r.location || {};
    const whereParts = loc.country === '中国' ? [loc.province, loc.city] : [loc.country, loc.city];
    const where = [...new Set(whereParts.filter(Boolean))].join(' · ') || r.region;
    if (where) html += `<div class="poi-location">📍 ${escapeHtml(where)}</div>`;
    const hiddenCount = Math.max(0, r.visits.length - POPUP_VISIT_COLLAPSE_THRESHOLD);
    if (hiddenCount > 0) {
        // 用行内 onclick 而不是事件委托——弹窗内容是 Leaflet bindPopup 存好
        // 的静态 HTML 字符串,不经过任何框架渲染,直接操作 DOM 最省事,不用
        // 另外找地方挂事件监听、还要处理弹窗关闭后监听器要不要清理的问题
        html += `<div class="visit-toggle" onclick="const el=this.nextElementSibling; const open=el.classList.toggle('expanded'); this.textContent = open ? '收起' : '展开全部 ${r.visits.length} 次拜访 ▾';">展开全部 ${r.visits.length} 次拜访 ▾</div>`;
    }
    html += `<div class="visit-list">`;
    r.visits.forEach((v, i) => {
        const dishes = (v.dishes || []).map(d => `<span>${escapeHtml(d)}</span>`).join('');
        const isOlder = i < hiddenCount;
        html += `<div class="visit${isOlder ? ' visit-extra' : ''}">
            <div class="visit-date">${formatDate(v.date)}</div>
            ${dishes ? `<div class="visit-dishes">${dishes}</div>` : ''}
            ${v.quote ? `<div class="visit-quote">${escapeHtml(v.quote)}</div>` : ''}
            ${v.postUrl ? `<a class="visit-link" href="${escapeHtml(v.postUrl)}" target="_blank" rel="noopener">查看原微博 →</a>` : ''}
        </div>`;
    });
    html += `</div>`;
    return html;
}

// 合并模式(?name=all 或以后支持的多选)下,弹窗/侧栏要多显示一个博主
// 标签才分得清"这家店是谁探的";单博主模式维持原样,不多显示这个标签。
let isCombinedView = false;

async function load() {
    const bloggerList = await loadBloggerList();
    setupBloggerSelect(bloggerList);
    const namesToLoad = bloggerName === 'all' ? bloggerList : [bloggerName];
    isCombinedView = namesToLoad.length > 1;

    // 纯静态读取:GitHub Pages 没有后端,直接 fetch 仓库里的 JSON 文件。
    // server.mjs 本地起服务时也是同一套相对路径,行为一致。合并模式下并行
    // 请求所有博主(Promise.all,不是依次 await——不然合并两个人就要等
    // 两倍时间),给每条餐厅打上 _blogger 标签(内部字段,跟现有的
    // _marker/_years 一个风格);某个博主的文件缺失/格式不对只跳过并
    // 警告,不因为一个人的数据有问题就让整页什么都不显示。
    const restaurants = [];
    const fetchResults = await Promise.all(
        namesToLoad.map(async name => {
            try {
                const resp = await fetch('data/' + encodeURIComponent(safeName(name)) + '/restaurants.json');
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const list = await resp.json();
                if (!Array.isArray(list)) throw new Error('数据格式错误');
                return { name, list };
            } catch (e) {
                console.warn(`加载"${name}"的数据失败,已跳过: ${e.message}`);
                return { name, list: null };
            }
        })
    );
    for (const { name, list } of fetchResults) {
        if (!list) continue;
        for (const r of list) {
            r._blogger = name;
            restaurants.push(r);
        }
    }

    document.getElementById('bloggerName').textContent = `${namesToLoad.join(' + ')}的美食地图`;
    document.getElementById('loadingHint').style.display = 'none';

    if (restaurants.length === 0) {
        document.getElementById('emptyHint').style.display = '';
        document.getElementById('emptyHint').textContent =
            `未找到"${namesToLoad.join('/')}"的数据。请先在本地运行 fetch-posts.mjs + extract-restaurants.mjs,或换用 ?name=陈晓卿 查看示例`;
        return;
    }

    const totalVisits = restaurants.reduce((s, r) => s + r.visits.length, 0);
    document.getElementById('stat').textContent = `${restaurants.length} 家餐厅 · ${totalVisits} 次拜访`;

    // 数据新鲜度对用户是不透明的——没有任何地方说明这份数据是什么时候的、
    // 会不会更新。restaurants.json 本身没存"抓取时间"这个字段(加这个字段
    // 要改抽取脚本,对现有数据没意义),退而求其次用"最近一次拜访记录的
    // 日期"当替代指标——至少能让用户知道数据大概新到什么程度,好于完全
    // 不提。
    const allDates = restaurants.flatMap(r => r.visits.map(v => Date.parse(v.date))).filter(t => !isNaN(t));
    if (allDates.length) {
        document.getElementById('dataFreshness').textContent = `数据含最近拜访:${formatDate(Math.max(...allDates))}`;
    }

    // 合并模式下按博主给标记加一圈外环颜色区分是谁探的,不用点开弹窗才知道。
    // 用黄金角配色(跟 yearColor 同一个思路)保证博主数量不管多少都尽量
    // 拉开色相;单博主模式没有这层环,视觉跟之前完全一样。
    const bloggerColorOf = new Map(namesToLoad.map((n, i) => [n, `hsl(${(i * 137.508) % 360}, 65%, 45%)`]));
    document.getElementById('bloggerLegend').innerHTML = isCombinedView
        ? namesToLoad
              .map(
                  n =>
                      `<span class="item"><span class="dot" style="background:${bloggerColorOf.get(n)}"></span>${escapeHtml(n)}</span>`
              )
              .join('')
        : '';

    // 拜访 ≥2 次的用金色高亮("回头客"信号),半径随拜访次数增大,一眼看出常去的地方
    function makeFoodIcon(r, delayMs) {
        const repeat = r.visits.length >= 2;
        const size = Math.min(26 + r.visits.length * 3, 44);
        // inline style 会整个覆盖掉 CSS 里 .food-pin/.food-pin.repeat 原有的
        // box-shadow(不是叠加),所以合并模式下要把原阴影也一起拼进来,
        // 不然点上的阴影会凭空消失,只剩博主色环
        const baseShadow = repeat
            ? 'inset 0 1px 2px rgba(255,255,255,.9), inset 0 -3px 4px rgba(43,33,24,.18), 0 0 10px rgba(163,105,15,.4)'
            : 'inset 0 1px 2px rgba(255,255,255,.9), inset 0 -3px 4px rgba(43,33,24,.18), 0 2px 8px rgba(43,33,24,.25)';
        const ringStyle = isCombinedView
            ? `box-shadow:0 0 0 3px ${bloggerColorOf.get(r._blogger) || '#888'}, ${baseShadow};`
            : '';
        return L.divIcon({
            className: '',
            html: `<div class="food-pin${repeat ? ' repeat' : ''}" style="width:${size}px;height:${size}px;animation-delay:${delayMs}ms;${ringStyle}">${foodIconImg(r.name, Math.round(size * 0.68))}</div>`,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
        });
    }

    // 聚类:密集区(如北京、桂林)几十个点挤在一起时收成数字气泡,放大到街道级再展开
    const clusterGroup = L.markerClusterGroup({
        maxClusterRadius: 45,
        disableClusteringAtZoom: 15,
        iconCreateFunction(cluster) {
            const count = cluster.getChildCount();
            // 分四档配色(紫→亮紫→金→红),数字越大颜色越"热",一眼看出哪片是真正的密集区
            const tier = count < 10 ? 1 : count < 30 ? 2 : count < 80 ? 3 : 4;
            const size = count < 10 ? 34 : count < 30 ? 42 : 50;
            return L.divIcon({
                className: '',
                html: `<div class="cluster-pin tier-${tier}" style="width:${size}px;height:${size}px;font-size:${size * 0.32}px">${count}</div>`,
                iconSize: [size, size],
            });
        },
    });

    restaurants.forEach((r, idx) => {
        const marker = L.marker([r.lat, r.lng], { icon: makeFoodIcon(r, Math.min(idx * 3, 450)) });
        marker.bindPopup(renderPopup(r), { maxWidth: 320 });
        clusterGroup.addLayer(marker);
        r._marker = marker; // 供侧栏列表点击联动
        r._years = r.visits
            .map(v => {
                const t = Date.parse(v.date);
                return isNaN(t) ? null : new Date(t).getFullYear();
            })
            .filter(y => y != null);
    });
    map.addLayer(clusterGroup);
    frameRestaurants(restaurants); // 世界级 fitBounds 在窄屏会缩成一细条,见 frameRestaurants 的处理

    const journey = setupJourney(clusterGroup);
    const sidebar = setupSidebar(restaurants, clusterGroup, journey);
    const choropleth = setupChoropleth(restaurants);
    setupFilters(restaurants, clusterGroup, sidebar, choropleth, journey);
    setupLocate(restaurants, sidebar);
    // 稍等一下再弹,而且一次只弹一个:三个气泡同时挂在屏幕上互相抢注意力,
    // 移动端还会叠着压住标题卡。点掉当前的才轮到下一个。合并模式下点回放
    // 按钮只会弹出"请先选一位博主"的提醒,这个指向它的气泡不排进队列。
    queuePointerHints([
        { targetSelector: '.locate-btn', text: '👉 点这里看看附近好吃的' },
        ...(isCombinedView ? [] : [{ targetSelector: '.journey-btn', text: '👉 点这里回放旅行轨迹' }]),
        { targetSelector: '#sidebarToggle', text: '👉 点这里看餐厅列表', arrowLeft: true },
    ]);
}

// "定位我"按钮的实现:拿到浏览器地理位置后,在地图上标出"你在这"并把侧栏
// 切到按距离排序的附近榜。不设硬性半径——博主是全球到处跑的美食向导,
// 与其猜一个截断距离不如把最近的几家原样列出来,由用户自己判断远不远。
function setupLocate(restaurants, sidebar) {
    let userMarker = null;
    // 定位权限一旦被拒绝,浏览器不会再弹系统授权框,之后每次点击都会立刻
    // 拿到同一个"已拒绝"错误——用户必须自己去系统/浏览器设置里手动改。
    // "浏览器设置"这个说法太笼统,iOS 和 Android 的操作路径完全不一样,
    // 按 UA 给出具体路径,不然等于没说。
    function geolocationDeniedMsg() {
        const ua = navigator.userAgent;
        if (/iPhone|iPad|iPod/.test(ua)) {
            return '定位被拒绝。请打开系统"设置" → 隐私与安全性 → 定位服务,确认已开启;再找到 Safari(或你使用的浏览器)把定位权限改成"允许",然后回来刷新本页重试。';
        }
        if (/Android/.test(ua)) {
            return '定位被拒绝。请点一下浏览器地址栏左侧的图标(或菜单里的"网站设置"),把"位置"权限改成"允许",然后刷新本页重试。';
        }
        return '定位被拒绝,请在浏览器设置里允许本站访问位置,然后刷新页面重试。';
    }
    onLocate = btn => {
        if (!navigator.geolocation) {
            alert('你的浏览器不支持定位');
            return;
        }
        btn.classList.add('loading');
        navigator.geolocation.getCurrentPosition(
            pos => {
                btn.classList.remove('loading');
                const { latitude: lat, longitude: lng } = pos.coords;
                if (userMarker) map.removeLayer(userMarker);
                userMarker = L.marker([lat, lng], {
                    icon: L.divIcon({
                        className: '',
                        html: '<div class="user-dot"></div>',
                        iconSize: [16, 16],
                        iconAnchor: [8, 8],
                    }),
                    zIndexOffset: 1000,
                }).addTo(map);
                map.setView([lat, lng], 12);
                sidebar.showNearby(lat, lng);
            },
            err => {
                btn.classList.remove('loading');
                const msg =
                    err.code === 1
                        ? geolocationDeniedMsg()
                        : err.code === 2
                          ? '无法获取定位,请检查设备定位服务是否开启'
                          : '定位超时,请重试';
                alert(msg);
            },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    };
}

// 旅行轨迹回放:把拜访按时间排成一条路线,可以像看时间胶片一样逐点播放。
// 进入轨迹模式后隐藏聚类图层(否则一堆气泡和一条线互相打架,看不清路线),
// 退出后恢复原来的聚类视图和年份滑块(两者互斥,轨迹模式下年份滑块没有
// 意义——轨迹本身就是按时间在动)。
//
// 点集不是一次性固定下来的,而是跟着筛选器走(见 setSource,由 setupFilters
// 的 apply() 调用):之前 journey 在初始化时就把全量数据算好了,筛到
// "2011 年的欧洲"再点回放,播的还是全部 285 个点,筛选等于没生效。
// 返回 { setSource, isActive, exit } 供筛选器和侧栏联动。
function setupJourney(clusterGroup) {
    const journeyBtn = document.querySelector('.journey-btn');
    const barEl = document.getElementById('journeyBar');
    const playBtn = document.getElementById('journeyPlay');
    const progressEl = document.getElementById('journeyProgress');
    const labelEl = document.getElementById('journeyLabel');
    const legendEl = document.getElementById('journeyLegend');
    const timebarEl = document.getElementById('timebar');

    let journey = [];
    // 按年份分配颜色:用黄金角(137.508°)在色环上取点,不管有多少年都能让
    // 相邻年份的颜色尽量拉开,不会挤成一片分不清——比按顺序等分色环更均匀
    let yearColor = () => 'hsl(0, 62%, 42%)';

    let active = false,
        playing = false,
        timer = null,
        index = 0,
        lastMode = 'near';
    // 飞机滑动动画的 rAF 句柄和等瓦片的兜底定时器:退出回放时必须停掉,
    // 否则退出之后最多还会有 1.6 秒在往已经从地图上移除的 marker 写坐标
    let rafId = null,
        tileWaitTimer = null;
    let timebarPrevDisplay = '';

    // 路径不是一条整体折线,而是"点i→点i+1"一段段的小折线,每段按终点所在
    // 年份上色——这样跨年移动时颜色会在年份边界处切换,同一年内的移动始终
    // 是同一色,一眼就能分清"这一片是哪年在这边转"而不是一整条糊在一起。
    let segments = [];
    // 远距离(飞机)的这一段画成弧线而不是直线——航线图传统上都用弧线表示
    // 长途飞行,直线反而不像"飞过去"、更像"贴地挪过去"。用二次贝塞尔曲线
    // 近似:取两点中点,往垂直方向偏移一点当控制点,弯曲程度跟距离成比例
    // (偏移量是中点到两端距离的固定比例,不是绝对像素值,长途线看起来
    // 弯得自然,短途线不会突然弓起一个很夸张的包)。
    // arcControlPoint/quadraticPoint 单独抽出来,是因为画弧线的 arcPoints
    // 和让飞机图标沿弧线滑动的 animateMarkerTo 必须用同一个控制点、同一条
    // 曲线——之前两边各算一套(画线用弧线公式,图标用直线插值),导致图标
    // 走的是直线、背后的线却是弯的,两者对不上。
    function arcControlPoint(a, b, bend) {
        const midLat = (a.lat + b.lat) / 2,
            midLng = (a.lng + b.lng) / 2;
        const dLat = b.lat - a.lat,
            dLng = b.lng - a.lng;
        return { lat: midLat - dLng * bend, lng: midLng + dLat * bend };
    }
    function quadraticPoint(a, ctrl, b, t) {
        return {
            lat: (1 - t) ** 2 * a.lat + 2 * (1 - t) * t * ctrl.lat + t ** 2 * b.lat,
            lng: (1 - t) ** 2 * a.lng + 2 * (1 - t) * t * ctrl.lng + t ** 2 * b.lng,
        };
    }
    function arcPoints(a, b, bend, steps = 24) {
        const ctrl = arcControlPoint(a, b, bend);
        const pts = [];
        for (let i = 0; i <= steps; i++) {
            const p = quadraticPoint(a, ctrl, b, i / steps);
            pts.push([p.lat, p.lng]);
        }
        return pts;
    }
    // 开车(近距离)的弧度比飞机(远距离)小得多——短途一小段路弓成跟长途
    // 一样的弧度会显得很夸张,只给一点点弯曲意思一下就够了
    function bendFor(isFar) {
        return isFar ? 0.45 : 0.15;
    }
    function rebuildSegments(uptoIndex) {
        for (const seg of segments) map.removeLayer(seg);
        segments = [];
        for (let j = 0; j < uptoIndex; j++) {
            const a = journey[j],
                b = journey[j + 1];
            const isFar = distanceKm(a.lat, a.lng, b.lat, b.lng) > FAR_THRESHOLD_KM;
            const latlngs = arcPoints(a, b, bendFor(isFar));
            const seg = L.polyline(latlngs, {
                color: yearColor(new Date(b.t).getFullYear()),
                weight: 3,
                opacity: 0.85,
                dashArray: '6 6',
                smoothFactor: 0, // 关掉路径简化——弧线在缩得很远时偏移只有几像素,不关的话会被简化成直线
            }).addTo(map);
            segments.push(seg);
        }
    }

    // 路过的每个地点留一个小食物图标(用跟主地图一致的 foodIconImg,一眼认出
    // 是同一家餐厅),随播放进度逐个"冒出来"而不是一开始就铺满——呼应
    // rebuildSegments 只画到当前进度为止的线段,两者进度保持一致
    let stopMarkers = [];
    function rebuildStopMarkers(uptoIndex) {
        for (const m of stopMarkers) map.removeLayer(m);
        stopMarkers = [];
        for (let j = 0; j <= uptoIndex; j++) {
            const pt = journey[j];
            const m = L.marker([pt.lat, pt.lng], {
                icon: L.divIcon({
                    className: '',
                    html: `<div class="journey-stop">${foodIconImg(pt.name, 14)}</div>`,
                    iconSize: [20, 20],
                    iconAnchor: [10, 10],
                }),
                zIndexOffset: 500,
            }).addTo(map);
            stopMarkers.push(m);
        }
    }

    // 两点之间距离决定用什么交通方式的图标——纯粹是视觉隐喻,不是真实
    // 交通方式数据,阈值(80km)选的是"市内开车 vs 跨城/跨国出行"的大致分界
    const FAR_THRESHOLD_KM = 80;
    function journeyIcon(mode) {
        const emoji = mode === 'far' ? '✈️' : '🚗';
        return L.divIcon({
            className: '',
            html: `<div class="journey-marker">${emoji}</div>`,
            iconSize: [26, 26],
            iconAnchor: [13, 13],
        });
    }
    const marker = L.marker([0, 0], {
        icon: journeyIcon('near'),
        zIndexOffset: 1000,
    });

    // 飞机图标之前只在瞬间跳到新位置时露一下脸,900ms 一晃就过去,根本看不清
    // 是什么图标。远距离的这一步改成让图标沿直线平滑"飞"过去(而不是瞬移),
    // 配合下面 play() 里给远距离步骤单独留出更长的停留时间,才看得出"飞机在飞"。
    // 返回一个 promise,在图标真正滑到终点时 resolve——播放调度(见下面的
    // tick())要靠这个知道"这一步到底什么时候才算真正落地",不能只靠猜
    // 一个数字当延时。
    function animateMarkerTo(from, to, duration) {
        const ctrl = arcControlPoint(from, to, bendFor(true)); // 跟 rebuildSegments 画的弧线用同一个控制点(飞机段的弯曲度)
        return new Promise(resolve => {
            const start = performance.now();
            function step(now) {
                // 退出回放后立刻收手:marker 已经从地图上移走了,继续按帧往上
                // 写坐标没有意义,而且这一段动画长达 1.6 秒
                if (!active) {
                    rafId = null;
                    resolve();
                    return;
                }
                const t = Math.min(1, (now - start) / duration);
                const p = quadraticPoint(from, ctrl, to, t);
                marker.setLatLng([p.lat, p.lng]);
                if (t < 1) rafId = requestAnimationFrame(step);
                else {
                    rafId = null;
                    resolve();
                }
            }
            rafId = requestAnimationFrame(step);
        });
    }

    // 镜头飞到新区域时,目标位置的瓦片往往还在下载——如果车/飞机图标不等
    // 瓦片就立刻开始滑动,看起来像"漂浮在一片空白/半空白的底图上飘过去"。
    // 用顶层的 tilesReady 标记等一下,超时(1.5s)兜底,不会因为某张瓦片
    // 一直加载不出来就卡住整个播放。
    function waitForTiles(maxWaitMs = 1200) {
        if (tilesReady) return Promise.resolve();
        return new Promise(resolve => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                baseLayer.off('load', finish);
                if (tileWaitTimer != null) {
                    clearTimeout(tileWaitTimer);
                    tileWaitTimer = null;
                }
                resolve();
            };
            baseLayer.on('load', finish);
            tileWaitTimer = setTimeout(finish, maxWaitMs);
        });
    }

    // flyTo/flyToBounds 调用完的那一刻,Leaflet 还没真的开始为目标视野请求
    // 新瓦片(要等动画推进几帧才会触发)——如果紧接着就去检查 tilesReady,
    // 拿到的还是"上一个视野"的旧状态(当时可能刚好是 true),等于没等。
    // 必须先等镜头动画本身跑完(moveend),这时候 Leaflet 才会把新视野需要
    // 的瓦片请求都发出去,tilesReady 也才会被正确地标记成"在加载"。
    function waitForMoveEnd() {
        return new Promise(resolve => map.once('moveend', resolve));
    }

    function renderStep(i, { pan = false, animateMarker = false } = {}) {
        index = i;
        progressEl.value = i;
        const pt = journey[i];
        const prev = journey[i - 1];
        rebuildSegments(i);
        rebuildStopMarkers(i);
        const distKm = prev ? distanceKm(prev.lat, prev.lng, pt.lat, pt.lng) : 0;
        const mode = distKm > FAR_THRESHOLD_KM ? 'far' : 'near';
        lastMode = mode;
        marker.setIcon(journeyIcon(mode));
        // 返回一个 promise,统一给 moveMarker 本身不返回值(直接瞬移)的
        // 情况包一层 resolve——调用方(tick())不用关心"这一步到底要不要
        // 动画"，只要等这个 promise 完成就代表图标已经真正落到位。
        function moveMarker() {
            if (!active) return Promise.resolve(); // 等镜头/瓦片的过程中退出了回放
            if (animateMarker && mode === 'far' && prev) return animateMarkerTo(prev, pt, 1600);
            marker.setLatLng([pt.lat, pt.lng]);
            return Promise.resolve();
        }
        const dishText = pt.dishes.length ? ` · ${pt.dishes.slice(0, 3).join('、')}` : '';
        labelEl.textContent = `${formatDate(pt.date)} ${pt.name}${dishText}`;
        // 近距离(市内开车)放大到看得清街道的程度;远距离(飞机跨城/跨国)
        // 缩小到能把起点和终点都塞进视野,不然缩放没变、地图会突然"跳"到
        // 看不出移动轨迹的一个小点。
        // 但如果这一步的移动本来就还在当前视野内,就不用再挪镜头——判断
        // "在视野内"必须连同缩放级别一起看,不能只看经纬度是否落在当前
        // 画面矩形里:刚进入回放时地图是缩到能装下整条轨迹的大视野,任何
        // 一个点几乎都"技术上"落在这个大矩形里,如果只判断这一条,镜头会
        // 永远卡在最初的大视野上、再也不放大——所以只在"当前缩放已经跟
        // 目标缩放很接近"时才认为"不需要再挪镜头",飞机步骤(缩放目标依
        // 每一步的两点距离而变)则维持原来每次都飞的行为,不做跳过判断。
        // 镜头真的要移动时,先等目标区域的瓦片加载完才让图标动,不然图标
        // 会先"到位"、瓦片才慢慢补上,看起来很突兀。renderStep 把这一串
        // "等镜头动画→等瓦片→挪图标"的 promise 链原样返回给调用方——
        // play() 的调度靠它知道这一步到底什么时候才算真正结束,不用再靠
        // 猜一个"应该够长"的固定延时(之前就是这么栽的:实际耗时经常比
        // 猜的延时长,下一步提前开始,新的镜头动画/瓦片请求跟上一步的还
        // 没结束就叠在一起,看起来永远都"没加载完就动")。
        if (pan) {
            if (mode === 'far' && prev) {
                map.flyToBounds(
                    [
                        [prev.lat, prev.lng],
                        [pt.lat, pt.lng],
                    ],
                    { padding: [80, 80], maxZoom: 8, duration: 2.2 }
                );
                return waitForMoveEnd().then(waitForTiles).then(moveMarker);
            } else {
                const zoomCloseEnough = Math.abs(map.getZoom() - 12) < 0.6;
                const alreadyVisible = zoomCloseEnough && map.getBounds().pad(-0.15).contains([pt.lat, pt.lng]);
                if (!alreadyVisible) {
                    map.flyTo([pt.lat, pt.lng], 12, { animate: true, duration: 0.9 });
                    return waitForMoveEnd().then(waitForTiles).then(moveMarker);
                }
                return moveMarker();
            }
        }
        return moveMarker();
    }

    function pause() {
        playing = false;
        playBtn.textContent = '▶';
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    }
    function play() {
        if (index >= journey.length - 1) index = 0; // 播放完了再点,从头再来一遍
        playing = true;
        playBtn.textContent = '⏸';
        // 之前用固定延时预估"这一步应该多久能播完",猜的数字一旦比实际
        // 耗时(镜头动画+等瓦片+图标滑动全部串联起来)短,下一步就会在上
        // 一步真正落地之前提前开始——新的镜头动画/瓦片请求跟旧的没结束
        // 的叠在一起,表现出来就是"图层还没加载完图标就已经在动"。改成
        // renderStep 返回一个"这一步真正完成"的 promise,等它 resolve
        // 之后才排下一步,不再靠猜时长兜底,只在落地后留一小段停留时间
        // 让人看清图标和标签。
        function tick() {
            if (!playing) return;
            if (index >= journey.length - 1) {
                pause();
                return;
            }
            Promise.resolve(renderStep(index + 1, { pan: true, animateMarker: true })).then(() => {
                if (!playing) return; // 等待落地的过程中可能被暂停了,不要再排下一步
                timer = setTimeout(tick, lastMode === 'far' ? 900 : 450);
            });
        }
        tick();
    }

    function enter() {
        dismissAllHints(); // 用户已经动手用起来了,引导气泡(含还没轮到的)全部撤掉
        active = true;
        journeyBtn.classList.add('active');
        map.removeLayer(clusterGroup);
        timebarPrevDisplay = timebarEl.style.display; // 轨迹模式下时间由播放进度表达,先记住原来的显示状态再隐藏,退出时还原
        timebarEl.style.display = 'none';
        marker.addTo(map);
        barEl.classList.add('show');
        renderStep(0, { pan: false });
        map.fitBounds(L.latLngBounds(journey.map(p => [p.lat, p.lng])), { padding: [60, 60] });
    }
    function exit() {
        active = false; // 先置位:正在跑的 animateMarkerTo 会在下一帧看到它并停手
        pause();
        if (rafId != null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
        if (tileWaitTimer != null) {
            clearTimeout(tileWaitTimer);
            tileWaitTimer = null;
        }
        journeyBtn.classList.remove('active');
        for (const seg of segments) map.removeLayer(seg);
        segments = [];
        for (const m of stopMarkers) map.removeLayer(m);
        stopMarkers = [];
        map.removeLayer(marker);
        barEl.classList.remove('show');
        timebarEl.style.display = timebarPrevDisplay;
        map.addLayer(clusterGroup);
        // 筛选条件把可见餐厅筛成 0 家时 clusterGroup 是空的,getBounds() 返回
        // 一个非法 bounds,fitBounds 会抛 "Bounds are not valid." ——退出回放
        // 这个动作本身没有失败的理由,没有点可看就别动镜头
        if (clusterGroup.getLayers().length) map.fitBounds(clusterGroup.getBounds(), { padding: [40, 40] });
    }

    // 筛选器每次重算可见集合都会调到这里。回放中途换点集会让进度条/线段
    // 跟正在播的内容错位,所以先退出回放再换。
    function setSource(visibleRestaurants) {
        if (active) exit();
        journey = [];
        for (const r of visibleRestaurants) {
            if (r.lat == null) continue;
            for (const v of r.visits) {
                const t = Date.parse(v.date);
                if (!isNaN(t))
                    journey.push({ t, date: v.date, lat: r.lat, lng: r.lng, name: r.name, dishes: v.dishes || [] });
            }
        }
        journey.sort((a, b) => a.t - b.t);
        const years = [...new Set(journey.map(p => new Date(p.t).getFullYear()))].sort((a, b) => a - b);
        yearColor = year => `hsl(${(years.indexOf(year) * 137.508) % 360}, 62%, 42%)`;
        legendEl.innerHTML = years
            .map(y => `<span class="item"><span class="dot" style="background:${yearColor(y)}"></span>${y}</span>`)
            .join('');
        progressEl.max = Math.max(1, journey.length - 1);
        index = 0;
    }

    // 合并模式下把两个人的拜访时间线揉在一起按时间顺序播放,会在城市之间
    // 没有意义地来回跳(两人是各自独立的行程,不是同一段旅程)——不如让
    // 用户用顶部已有的下拉框先选定一位博主,回放才是在讲一个人的故事
    onToggleJourney = () => {
        if (active) {
            exit();
            return;
        }
        if (isCombinedView) {
            alert(
                '轨迹回放是按一个人的时间顺序播放的,"全部"模式下两人的行程会混在一起、来回跳,没有意义。请先用顶部下拉框选择一位博主,再点这个按钮。'
            );
            return;
        }
        // 筛选之后剩下的拜访记录不足两条,连不成一条有意义的路线
        if (journey.length < 2) {
            alert('当前筛选条件下不足两次拜访,连不成一条轨迹。放宽年份或地区筛选后再试。');
            return;
        }
        enter();
    };
    playBtn.addEventListener('click', () => {
        playing ? pause() : play();
    });
    progressEl.addEventListener('input', () => {
        pause();
        renderStep(Number(progressEl.value), { pan: false });
    });
    document.getElementById('journeyExit').addEventListener('click', exit);

    return { setSource, isActive: () => active, exit };
}

// 侧栏餐厅列表:按拜访次数排序,支持按名称搜索;点击项目让地图聚焦该标记并弹出详情。
// 返回 { refresh(visibleSet), showNearby(lat,lng) } 供时间滑块/定位按钮联动。
function setupSidebar(restaurants, clusterGroup, journey) {
    const sorted = [...restaurants].sort((a, b) => b.visits.length - a.visits.length);
    const listEl = document.getElementById('sidebarList');
    const searchEl = document.getElementById('sidebarSearch');
    const bannerEl = document.getElementById('nearbyBanner');
    const bannerTextEl = document.getElementById('nearbyBannerText');
    let visibleSet = null; // null = 不做时间过滤(全部可见)
    let nearbyOrigin = null; // {lat,lng} = 处于"附近好吃的"模式

    function baseList() {
        let list = visibleSet ? sorted.filter(r => visibleSet.has(r)) : sorted;
        if (nearbyOrigin) {
            list = [...list].sort(
                (a, b) =>
                    distanceKm(nearbyOrigin.lat, nearbyOrigin.lng, a.lat, a.lng) -
                    distanceKm(nearbyOrigin.lat, nearbyOrigin.lng, b.lat, b.lng)
            );
        }
        return list;
    }

    function renderList() {
        const q = normalizeSearchText(searchEl.value);
        const dishHits = new Map(); // 命中菜品(而非店名)的 r → 具体菜名,渲染时标注
        let filtered = baseList();
        if (q) {
            filtered = filtered.filter(r => {
                if (normalizeSearchText(r.name).includes(q)) return true;
                const dish = matchedDishOf(r, q);
                if (dish) {
                    dishHits.set(r, dish);
                    return true;
                }
                return false;
            });
        }
        if (nearbyOrigin && !q) filtered = filtered.slice(0, 20); // 不限定搜索时只列最近 20 家,避免刷到天荒地老
        if (filtered.length === 0) {
            // 空态给一条一键出路:走到这里的用户往往是搜索词+年份+地区叠出了
            // 一个空集,挨个撤销比一键清除麻烦得多(点击处理在 listEl 的委托里)
            listEl.innerHTML =
                '<div class="sidebar-empty">没有匹配的餐厅<span class="clear-filters">清除筛选</span></div>';
            return;
        }
        listEl.innerHTML = filtered
            .map(r => {
                const idx = sorted.indexOf(r);
                const rightSpan = nearbyOrigin
                    ? `<span class="dist">${formatDistance(distanceKm(nearbyOrigin.lat, nearbyOrigin.lng, r.lat, r.lng))}</span>`
                    : `<span class="count${r.visits.length >= 2 ? ' repeat' : ''}">${r.visits.length}次</span>`;
                // 收集所有拜访中提到的菜品,去重后取前 5 个,当作店铺的"菜品预览"——
                // 跟下面的 dish(按搜索词命中的具体那道菜)是两件事:dishesHtml
                // 不管有没有搜索都显示,dish 只在搜索词命中了某道菜时才出现,
                // 用来说明"这家店为什么会被搜出来"。
                const allDishes = [...new Set(r.visits.flatMap(v => v.dishes || []))];
                const dishesHtml = allDishes.length
                    ? `<div class="dishes">${allDishes
                          .slice(0, 5)
                          .map(d => `<span class="dish-tag">${escapeHtml(d)}</span>`)
                          .join('')}${allDishes.length > 5 ? '…' : ''}</div>`
                    : '';
                const dish = dishHits.get(r);
                return `<div class="sidebar-item" data-idx="${idx}">
                <span class="emoji">${foodIconImg(r.name, 18)}</span>
                <div style="flex:1;min-width:0;overflow:hidden">
                    <span class="name">${escapeHtml(r.name)}${dish ? ` <span class="dish-hit">· ${escapeHtml(dish)}</span>` : ''}</span>
                    ${dishesHtml}
                </div>
                ${isCombinedView && r._blogger ? `<span class="blogger-tag">${escapeHtml(r._blogger)}</span>` : ''}
                ${rightSpan}
            </div>`;
            })
            .join('');
    }
    renderList();
    // 搜索框的 input 监听在 setupFilters 里:搜索现在跟年份/地区一样驱动
    // 全局可见集(地图图层+侧栏+回放点集),不再只是侧栏内部的列表过滤

    const toggleBtn = document.getElementById('sidebarToggle');
    const sidebarEl = document.getElementById('sidebar');
    listEl.addEventListener('click', e => {
        if (e.target.closest('.clear-filters')) {
            if (onClearFilters) onClearFilters();
            return;
        }
        const item = e.target.closest('.sidebar-item');
        if (!item) return;
        const r = sorted[Number(item.dataset.idx)];
        if (!r || !r._marker) return;
        // 回放模式下 clusterGroup 已经从地图上移除(见 setupJourney 的 enter),
        // 直接 zoomToShowLayer 会在 markercluster 内部抛错、弹窗也打不开,
        // 表现出来就是"侧栏点了没反应"。用户点某家店就是想看它的详情,
        // 那就先退出回放再聚焦,而不是让这一整块 UI 变成哑的。
        if (journey.isActive()) journey.exit();
        // 窄屏上侧栏近乎全宽,不收起的话弹窗会整个开在它底下,看起来还是
        // "点了没反应"——点了某家店就是要看它,侧栏先让路
        if (window.innerWidth <= 640) {
            sidebarEl.classList.add('collapsed');
            toggleBtn.classList.add('collapsed');
        }
        // 标记可能仍被聚合在数字气泡里,zoomToShowLayer 会自动放大到它单独显示为止
        clusterGroup.zoomToShowLayer(r._marker, () => r._marker.openPopup());
    });

    toggleBtn.addEventListener('click', () => {
        sidebarEl.classList.toggle('collapsed');
        toggleBtn.classList.toggle('collapsed');
    });

    document.getElementById('nearbyBack').addEventListener('click', () => {
        nearbyOrigin = null;
        bannerEl.style.display = 'none';
        renderList();
    });

    return {
        refresh(newVisibleSet) {
            visibleSet = newVisibleSet;
            renderList();
        },
        showNearby(lat, lng) {
            nearbyOrigin = { lat, lng };
            const nearest = baseList()[0];
            const nearestKm = nearest ? distanceKm(lat, lng, nearest.lat, nearest.lng) : Infinity;
            bannerTextEl.textContent = nearestKm > 100 ? `附近暂无记录,以下是离你最近的地点` : `离你最近`;
            bannerEl.style.display = 'flex';
            sidebarEl.classList.remove('collapsed');
            toggleBtn.classList.remove('collapsed');
            searchEl.value = '';
            searchEl.dispatchEvent(new Event('input')); // 搜索驱动全局可见集,清空后要让 apply() 把地图图层也还原
            renderList();
        },
    };
}

// 搜索框 + 年份滑块 + 洲/国/省/市四级联动下拉的组合筛选器。三者共享同一套
// "重算可见集合"逻辑(取交集),这样"搜牛肉、2020年、在广东"这种组合筛选
// 是自然成立的,不需要分别维护几套状态。重建 clusterGroup 的图层而非仅调
// 透明度——否则聚合气泡上的数字会继续把范围外的点计进去,失去"筛选"的意义。
const REGION_LEVELS = [
    { key: 'continent', id: 'continentSelect', placeholder: '全部洲' },
    { key: 'country', id: 'countrySelect', placeholder: '全部国家' },
    { key: 'province', id: 'provinceSelect', placeholder: '全部省' },
    { key: 'city', id: 'citySelect', placeholder: '全部市' },
];

// 兼容两种数据来源:geocode-regions.mjs 写入的结构化 location(优先),
// 或旧版按发帖 IP 算出的扁平 region 字段(退化成"只有市"这一级)。
function regionOf(r) {
    const loc = r.location || {};
    return {
        continent: loc.continent || null,
        country: loc.country || null,
        province: loc.province || null,
        city: loc.city || r.region || null,
    };
}

// "清除筛选"一键复位(侧栏空态里的快捷出路),由 setupFilters 装配——
// 搜索、年份、地区三套状态都归它管,别处只负责触发
let onClearFilters = null;

function setupFilters(restaurants, clusterGroup, sidebar, choropleth, journey) {
    const allYears = restaurants.flatMap(r => r._years);
    const hasYearFilter = allYears.length > 0 && Math.min(...allYears) !== Math.max(...allYears);
    const minYear = hasYearFilter ? Math.min(...allYears) : null;
    const maxYear = hasYearFilter ? Math.max(...allYears) : null;

    const fromEl = document.getElementById('yearFrom');
    const toEl = document.getElementById('yearTo');
    const fromLabel = document.getElementById('yearFromLabel');
    const toLabel = document.getElementById('yearToLabel');
    const fillEl = document.getElementById('yearRangeFill');
    const searchEl = document.getElementById('sidebarSearch');
    if (hasYearFilter) {
        document.getElementById('timebar').style.display = 'flex';
        for (const el of [fromEl, toEl]) {
            el.min = minYear;
            el.max = maxYear;
        }
        fromEl.value = minYear;
        toEl.value = maxYear;
    }

    // 单轴双手柄:拖动一端不能越过另一端,而是把对方推着走——比"允许穿过
    // 再在计算时交换 from/to"更符合直觉,用户看到的手柄位置和自己拖动的
    // 手感一致,不会出现"明明在拖右边,数字却突然变成左边"的错位感。
    function clampHandles(movedEl) {
        if (Number(fromEl.value) > Number(toEl.value)) {
            if (movedEl === fromEl) toEl.value = fromEl.value;
            else fromEl.value = toEl.value;
        }
    }
    function updateFill() {
        if (!hasYearFilter) return;
        const min = Number(fromEl.min),
            max = Number(fromEl.max);
        const THUMB_RADIUS = 8; // 手柄半径,和 .range-input::-webkit/moz-range-thumb 的尺寸对应
        const trackWidth = document.getElementById('yearRangeSlider').offsetWidth - THUMB_RADIUS * 2;
        const pxPos = v => THUMB_RADIUS + (max === min ? 0 : ((v - min) / (max - min)) * trackWidth);
        const left = pxPos(Number(fromEl.value)),
            right = pxPos(Number(toEl.value));
        fillEl.style.left = left + 'px';
        fillEl.style.width = Math.max(0, right - left) + 'px';
    }

    const hasAnyRegion = restaurants.some(r => Object.values(regionOf(r)).some(Boolean));
    const selects = Object.fromEntries(REGION_LEVELS.map(l => [l.key, document.getElementById(l.id)]));
    if (hasAnyRegion) document.getElementById('regionFilters').style.display = '';

    // 按"排在它前面的层级当前选了什么"筛出候选餐厅,用来给某一级下拉生成选项——
    // 这就是级联的核心:选了"中国"之后,"省"这一级只列中国的省,不会混进法国的大区
    function candidatesAbove(levelIdx) {
        return restaurants.filter(r => {
            const reg = regionOf(r);
            for (let i = 0; i < levelIdx; i++) {
                const val = selects[REGION_LEVELS[i].key].value;
                if (val && reg[REGION_LEVELS[i].key] !== val) return false;
            }
            return true;
        });
    }

    function populateLevel(levelIdx) {
        const { key, placeholder } = REGION_LEVELS[levelIdx];
        const selectEl = selects[key];
        const counts = new Map();
        for (const r of candidatesAbove(levelIdx)) {
            const v = regionOf(r)[key];
            if (v) counts.set(v, (counts.get(v) || 0) + 1);
        }
        const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        selectEl.innerHTML =
            `<option value="">${placeholder}</option>` +
            entries.map(([v, c]) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}(${c})</option>`).join('');
    }

    // 某一级变化时,它右边的所有层级都要清空重新生成选项(不然会出现
    // "洲选了欧洲,市却还停留在之前选的广州市"这种不一致状态)
    function cascadeFrom(changedIdx) {
        for (let i = changedIdx + 1; i < REGION_LEVELS.length; i++) {
            selects[REGION_LEVELS[i].key].value = '';
            populateLevel(i);
        }
    }

    if (hasAnyRegion) {
        populateLevel(0);
        REGION_LEVELS.forEach((level, idx) => {
            selects[level.key].addEventListener('change', () => {
                cascadeFrom(idx);
                frameRestaurants(apply());
            });
        });
        // 初始就把下面几级的选项铺好(此时都是"全部",候选是全量数据)
        for (let i = 1; i < REGION_LEVELS.length; i++) populateLevel(i);
    }

    const totalVisitsAll = restaurants.reduce((s, r) => s + r.visits.length, 0);

    let lastVisible = restaurants;
    function apply() {
        let from = minYear,
            to = maxYear;
        if (hasYearFilter) {
            from = Number(fromEl.value);
            to = Number(toEl.value);
            fromLabel.textContent = from;
            toLabel.textContent = to;
            updateFill();
        }
        const q = normalizeSearchText(searchEl.value);

        const visible = restaurants.filter(r => {
            if (!matchesSearch(r, q)) return false;
            if (hasYearFilter && !r._years.some(y => y >= from && y <= to)) return false;
            if (!hasAnyRegion) return true;
            const reg = regionOf(r);
            return REGION_LEVELS.every(({ key }) => !selects[key].value || reg[key] === selects[key].value);
        });
        clusterGroup.clearLayers();
        clusterGroup.addLayers(visible.map(r => r._marker));

        const isFiltered = visible.length !== restaurants.length;
        const visitCount = visible.reduce((s, r) => s + r.visits.length, 0);
        const parts = [];
        if (q) parts.push(`搜索"${searchEl.value.trim()}"`);
        if (hasYearFilter && (from !== minYear || to !== maxYear)) parts.push(`${from}–${to} 年`);
        if (hasAnyRegion) {
            const picked = REGION_LEVELS.map(({ key }) => selects[key].value).filter(Boolean);
            if (picked.length) parts.push(picked.join(' / '));
        }
        document.getElementById('stat').textContent = isFiltered
            ? `${visible.length} 家餐厅 · ${visitCount} 次拜访(${parts.join(' · ')},共 ${restaurants.length} 家)`
            : `${restaurants.length} 家餐厅 · ${totalVisitsAll} 次拜访`;

        sidebar.refresh(isFiltered ? new Set(visible) : null);
        choropleth.update(visible);
        // 回放的点集跟着筛选走,否则筛完再点回放播的还是全量数据
        journey.setSource(visible);
        lastVisible = visible;
        return visible;
    }
    // 搜索驱动可见集但不挪镜头:正在打字时镜头跳来跳去很晕。年份/地区是
    // 明确的"我要看某个范围"的动作,选完把镜头对过去(见 frameRestaurants);
    // 滑块用 change(松手)而不是 input 触发取景,拖动过程中只刷数据不动镜头。
    searchEl.addEventListener('input', apply);
    if (hasYearFilter) {
        fromEl.addEventListener('input', () => {
            clampHandles(fromEl);
            apply();
        });
        toEl.addEventListener('input', () => {
            clampHandles(toEl);
            apply();
        });
        fromEl.addEventListener('change', () => frameRestaurants(lastVisible));
        toEl.addEventListener('change', () => frameRestaurants(lastVisible));
        document.getElementById('yearReset').addEventListener('click', () => {
            fromEl.value = minYear;
            toEl.value = maxYear;
            frameRestaurants(apply());
        });
    }
    onClearFilters = () => {
        searchEl.value = '';
        if (hasYearFilter) {
            fromEl.value = minYear;
            toEl.value = maxYear;
        }
        if (hasAnyRegion) {
            for (const { key } of REGION_LEVELS) selects[key].value = '';
            // 下级下拉的选项计数是在旧的上级选择下算出来的,一并重铺
            for (let i = 1; i < REGION_LEVELS.length; i++) populateLevel(i);
        }
        frameRestaurants(apply());
    };
    apply();
}

load();
