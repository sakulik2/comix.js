/**
 * 漫画流媒体后端核心配置
 */
export const config = {
    // 原始漫画存放区 (建议使用绝对路径)
    RAW_LIBRARY_PATH: '/library/raw/',
    
    // 影子缓存存放区
    CACHE_LIBRARY_PATH: '/library/cache/',
    
    // 允许的漫画后缀格式
    SUPPORTED_EXTENSIONS: ['.cbr', '.rar', '.cbz', '.zip', '.pdf'],
    
    // 并发解压任务限制 (建议根据服务器 CPU 核心数调整，默认 2 比较稳妥)
    CONCURRENCY: 2,
    
    // 是否在 Express 服务启动时自动执行全库扫描/补全
    AUTO_SCAN_ON_STARTUP: true,
    
    // 服务监听端口
    PORT: 3000
};
