import fs from 'fs-extra';
import path from 'path';

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

const SETTINGS_FILE = './settings.json';
let settings = {};
try {
    if (fs.existsSync(SETTINGS_FILE)) {
        settings = fs.readJsonSync(SETTINGS_FILE);
    }
} catch (e) {
    console.error('[Config] 读取 settings.json 失败，将使用环境变量与默认配置:', e.message);
}

/**
 * 漫画流媒体后端核心配置
 * 所有选项优先从 settings.json 加载，其次为同名环境变量，最后为默认值
 */
export const config = {
    // 原始漫画存放区
    RAW_LIBRARY_PATH: settings.RAW_LIBRARY_PATH || process.env.RAW_LIBRARY_PATH || './library/raw/',

    // 影子缓存存放区
    CACHE_LIBRARY_PATH: settings.CACHE_LIBRARY_PATH || process.env.CACHE_LIBRARY_PATH || './library/cache/',

    // ID 映射表文件路径
    MAPPING_FILE: settings.MAPPING_FILE || process.env.MAPPING_FILE || './mapping.json',

    // 允许的漫画后缀格式
    SUPPORTED_EXTENSIONS: settings.SUPPORTED_EXTENSIONS || ['.cbr', '.rar', '.cbz', '.zip', '.pdf'],

    // 并发解压任务限制
    CONCURRENCY: settings.CONCURRENCY !== undefined ? parseInt(settings.CONCURRENCY, 10) : (parseInt(process.env.CONCURRENCY, 10) || 2),

    // 是否在 Express 服务启动时自动执行全库扫描/补全
    AUTO_SCAN_ON_STARTUP: settings.AUTO_SCAN_ON_STARTUP !== undefined ? !!settings.AUTO_SCAN_ON_STARTUP : (process.env.AUTO_SCAN_ON_STARTUP !== 'false'),

    // 是否开启图片解压后的 WebP 统一优化转码 (低配电脑建议保持 false 提升解压速度)
    OPTIMIZE_IMAGES: settings.OPTIMIZE_IMAGES !== undefined ? !!settings.OPTIMIZE_IMAGES : (process.env.OPTIMIZE_IMAGES === 'true'),

    // 图片转码的并发线程/任务限制数
    OPTIMIZE_CONCURRENCY: settings.OPTIMIZE_CONCURRENCY !== undefined ? parseInt(settings.OPTIMIZE_CONCURRENCY, 10) : (parseInt(process.env.OPTIMIZE_CONCURRENCY, 10) || 2),

    // 免转码的文件大小阈值 (单位字节，默认 300KB)，小于该体积的图片直接跳过转码以减轻 CPU 压力
    OPTIMIZE_MIN_FILE_SIZE: settings.OPTIMIZE_MIN_FILE_SIZE !== undefined ? parseInt(settings.OPTIMIZE_MIN_FILE_SIZE, 10) : (parseInt(process.env.OPTIMIZE_MIN_FILE_SIZE, 10) || 300 * 1024),

    // 服务监听端口
    PORT: settings.PORT !== undefined ? parseInt(settings.PORT, 10) : (parseInt(process.env.PORT, 10) || 3000),

    // 鉴权 API 秘钥 (如果设置为空，则视为禁用安全校验，建议在生产环境强覆盖)
    API_KEY: settings.API_KEY !== undefined ? settings.API_KEY : (process.env.API_KEY !== undefined ? process.env.API_KEY : '')
};

/**
 * 保存配置到本地 settings.json 并更新内存配置
 */
export async function saveConfig(newConfig) {
    // 更新内存中的 config
    Object.assign(config, newConfig);
    // 写入 settings.json
    await fs.writeJson(SETTINGS_FILE, config, { spaces: 2 });
}
