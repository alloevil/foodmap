// 本地起一个最小静态文件 server(纯 Node 内置 http,不引入新依赖),行为与
// GitHub Pages 完全一致——index.html 用相对路径 fetch data/<name>/restaurants.json,
// 本地开发和线上静态托管走的是同一套代码,不需要额外的 /api 层。
//
// 安全边界(踩过的坑,别改回去):
//   1. 仓库根目录里有 cookies.json(微博登录态)和 ai-config.json(LLM API
//      Key)。两者都在 .gitignore 里,但"把 ROOT 整个当静态根"会让它们照样
//      从 HTTP 出去。所以这里不是"禁止穿越到 ROOT 之外",而是反过来的白名单:
//      只放行 GitHub Pages 上真正会被访问的那几类路径,其余一律 404。
//      posts_raw.json 同理——它明确"默认不进 git",也就不该从本地 server 漏出去。
//   2. 默认只监听 127.0.0.1。之前绑在通配地址上,同一 WiFi 下任何人都能把
//      上面那两个文件直接下载走。要对外暴露得显式传 --host。
//   3. 路径解析必须容错:decodeURIComponent 遇到畸形百分号编码(GET /%zz)
//      会抛 URIError,在 request handler 里抛出去就是未捕获异常,整个进程直接
//      退出——一个 curl 就能把 server 打挂。
//
// 用法: node server.mjs [--port 3457] [--host 127.0.0.1]
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

export const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.geojson': 'application/geo+json; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

// 单文件白名单(根目录下只有这几个该被访问)
const ROOT_FILES = new Set(['index.html', '.nojekyll']);

/** 路径段数组是否在白名单内。段已保证不含 '' / '.' / '..'。 */
function isAllowed(segments) {
    if (segments.length === 1) return ROOT_FILES.has(segments[0]);
    switch (segments[0]) {
        // 地图页要的静态资源(图标、洲边界 geojson)和 README 里引用的截图
        case 'assets':
        case 'docs':
            return true;
        // 数据目录只放行地图页真正消费的两个文件:博主名单 + 结构化餐厅数据。
        // posts_raw.json 落在同一层目录里,必须被挡掉。
        case 'data':
            if (segments.length === 2) return segments[1] === 'bloggers.json';
            return segments.length === 3 && segments[2] === 'restaurants.json';
        default:
            return false;
    }
}

/**
 * 请求 URL 的 pathname → { status, file }。
 * 400: 路径本身不合法(畸形百分号编码 / 含 NUL)。
 * 404: 合法但不在白名单里(含任何试图跳出仓库的写法)。
 * 200: 放行,file 是绝对路径。
 * 抽成纯函数是为了能单测——server.mjs 之前这段逻辑一行都没测,三个安全问题
 * 全出在这里。
 */
export function resolveRequest(rawPath) {
    let decoded;
    try {
        decoded = decodeURIComponent(rawPath);
    } catch {
        return { status: 400 };
    }
    if (decoded.includes('\0')) return { status: 400 };

    // 逐段校验而不是 normalize 之后比较字符串前缀:之前用
    // `filePath.startsWith(ROOT)` 判断有没有穿越,ROOT 末尾没有分隔符,
    // "/../foodmap-secret/x.json" 归一化成 "<父目录>/foodmap-secret/x.json"
    // 照样通过前缀比较。按段过滤掉 '.'、直接拒掉 '..',从构造上就出不去。
    const segments = decoded.split('/').filter(s => s !== '' && s !== '.');
    if (segments.length === 0) segments.push('index.html');
    if (segments.some(s => s === '..')) return { status: 404 };
    if (!isAllowed(segments)) return { status: 404 };

    const file = path.join(ROOT, ...segments);
    // 兜底断言:逐段校验已经保证跳不出去,这里只是不让将来改动悄悄破坏该不变量
    if (!file.startsWith(ROOT + path.sep)) return { status: 404 };
    return { status: 200, file };
}

function main() {
    const args = process.argv.slice(2);
    const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : d; };
    const PORT = Number(opt('port')) || 3457;
    const HOST = opt('host', '127.0.0.1');

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const { status, file } = resolveRequest(url.pathname);
        if (status !== 200) { res.writeHead(status); res.end(status === 400 ? 'Bad Request' : 'Not found'); return; }

        fs.readFile(file, (err, data) => {
            if (err) { res.writeHead(404); res.end('Not found'); return; }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
            res.end(data);
        });
    });

    server.listen(PORT, HOST, () => {
        console.log(`美食地图: http://${HOST}:${PORT}/`);
        console.log(`(默认展示示例数据"陈晓卿",用 ?name=<博主名> 切换)`);
    });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
