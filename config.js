// 全局日志时间戳挂钩：自动为所有 console.log 和 console.error 输出前置本地时间戳
const originalLog = console.log;
const originalError = console.error;

function getLogTimestamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = now.getFullYear();
    const mm = pad(now.getMonth() + 1);
    const dd = pad(now.getDate());
    const hh = pad(now.getHours());
    const min = pad(now.getMinutes());
    const ss = pad(now.getSeconds());
    return `[${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}]`;
}

console.log = function(...args) {
    originalLog.apply(console, [getLogTimestamp(), ...args]);
};

console.error = function(...args) {
    originalError.apply(console, [getLogTimestamp(), ...args]);
};

/**
 * 漫画流媒体后端核心配置
 * 所有选项均可通过同名环境变量覆盖
 */
export const config = {
    // 原始漫画存放区 (默认修改为执行目录下的相对路径，支持通过环境变量覆盖)
    RAW_LIBRARY_PATH: process.env.RAW_LIBRARY_PATH || './library/raw/',

    // 影子缓存存放区
    CACHE_LIBRARY_PATH: process.env.CACHE_LIBRARY_PATH || './library/cache/',

    // ID 映射表文件路径 (Docker 部署时建议指向持久化卷内的路径)
    MAPPING_FILE: process.env.MAPPING_FILE || './mapping.json',

    // 允许的漫画后缀格式
    SUPPORTED_EXTENSIONS: ['.cbr', '.rar', '.cbz', '.zip', '.pdf'],

    // 并发解压任务限制 (建议根据服务器 CPU 核心数调整，默认 2 比较稳妥)
    CONCURRENCY: parseInt(process.env.CONCURRENCY) || 2,

    // 是否在 Express 服务启动时自动执行全库扫描/补全
    AUTO_SCAN_ON_STARTUP: process.env.AUTO_SCAN_ON_STARTUP !== 'false',

    // 是否开启图片解压后的 WebP 统一优化转码 (低配电脑建议保持 false 提升解压速度)
    OPTIMIZE_IMAGES: process.env.OPTIMIZE_IMAGES === 'true',

    // 图片转码的并发线程/任务限制数
    OPTIMIZE_CONCURRENCY: parseInt(process.env.OPTIMIZE_CONCURRENCY) || 2,

    // 免转码的文件大小阈值 (单位字节，默认 300KB)，小于该体积的图片直接跳过转码以减轻 CPU 压力
    OPTIMIZE_MIN_FILE_SIZE: parseInt(process.env.OPTIMIZE_MIN_FILE_SIZE) || 300 * 1024,

    // 服务监听端口
    PORT: parseInt(process.env.PORT) || 3000,

    // 鉴权 API 秘钥 (如果设置为空，则视为禁用安全校验，建议在生产环境强覆盖)
    API_KEY: process.env.API_KEY !== undefined ? process.env.API_KEY : ''
};
