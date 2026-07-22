/**
 * 项目一律用系统装的 Chrome(见 lib/chrome-path.js),不需要 puppeteer 自带的
 * Chrome for Testing,跳过下载以避免 npm install 在无网络/被墙环境卡住失败。
 * @type {import('puppeteer').Configuration}
 */
module.exports = {
  skipDownload: true,
};
