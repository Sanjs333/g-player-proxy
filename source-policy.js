import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY_FILE = path.join(__dirname, "source-policy.json");

export const SOURCE_LINES = {
    A: "GDStudio",
    B: "祈杰 meting",
    C: "落月 VKeys",
    D: "OpenMusic",
    E: "Bugpk",
    F: "网易云直连",
    G: "injahow meting",
    H: "残像API",
};

export const SOURCE_CAPABILITIES = [
    { id: "gdstudio-netease-search", line: "A", platform: "网易云", feature: "搜索" },
    { id: "gdstudio-kuwo-search", line: "A", platform: "酷我", feature: "搜索" },
    { id: "gdstudio-joox-search", line: "A", platform: "JOOX", feature: "搜索" },
    { id: "gdstudio-netease-song", line: "A", platform: "网易云", feature: "播放" },
    { id: "gdstudio-kuwo-song", line: "A", platform: "酷我", feature: "播放" },
    { id: "gdstudio-joox-song", line: "A", platform: "JOOX", feature: "播放" },
    { id: "gdstudio-netease-lyric", line: "A", platform: "网易云", feature: "歌词" },
    { id: "gdstudio-kuwo-lyric", line: "A", platform: "酷我", feature: "歌词" },
    { id: "gdstudio-joox-lyric", line: "A", platform: "JOOX", feature: "歌词" },
    { id: "gdstudio-kw-by-name", line: "A", platform: "酷我", feature: "歌词兜底" },
    { id: "gdstudio-cover", line: "A", platform: "通用", feature: "封面" },
    { id: "qijieya-netease-search", line: "B", platform: "网易云", feature: "搜索" },
    { id: "qijieya-tencent-search", line: "B", platform: "QQ", feature: "搜索" },
    { id: "qijieya-netease-song", line: "B", platform: "网易云", feature: "播放" },
    { id: "qijieya-tencent-song", line: "B", platform: "QQ", feature: "播放" },
    { id: "qijieya-netease-lyric", line: "B", platform: "网易云", feature: "歌词" },
    { id: "qijieya-tencent-lyric", line: "B", platform: "QQ", feature: "歌词" },
    { id: "qijieya-netease-playlist", line: "B", platform: "网易云", feature: "歌单" },
    { id: "qijieya-tencent-playlist", line: "B", platform: "QQ", feature: "歌单" },
    { id: "vkeys-tencent-search", line: "C", platform: "QQ", feature: "搜索" },
    { id: "vkeys-tencent-song", line: "C", platform: "QQ", feature: "播放" },
    { id: "openmusic-kuwo-search", line: "D", platform: "酷我", feature: "搜索" },
    { id: "openmusic-kuwo-song", line: "D", platform: "酷我", feature: "播放" },
    { id: "openmusic-kuwo-lyr", line: "D", platform: "酷我", feature: "歌词" },
    { id: "openmusic-kuwo-song-lyric-fallback", line: "D", platform: "酷我", feature: "歌词兜底" },
    { id: "bugpk-netease-song", line: "E", platform: "网易云", feature: "播放" },
    { id: "bugpk-aggregate-netease", line: "E", platform: "网易云", feature: "播放备用" },
    { id: "bugpk-netease-lyric", line: "E", platform: "网易云", feature: "歌词" },
    { id: "netease-playlist-detail", line: "F", platform: "网易云", feature: "歌单详情" },
    { id: "netease-song-detail", line: "F", platform: "网易云", feature: "歌曲详情" },
    { id: "injahow-netease-playlist", line: "G", platform: "网易云", feature: "歌单" },
    { id: "injahow-tencent-playlist", line: "G", platform: "QQ", feature: "歌单" },
    { id: "apicx-kuwo-search", line: "H", platform: "酷我", feature: "搜索" },
    { id: "apicx-kuwo-song", line: "H", platform: "酷我", feature: "播放" },
    { id: "apicx-kuwo-lyric", line: "H", platform: "酷我", feature: "歌词" },
];

const LOCAL_CAPABILITIES = [
    { id: "stream-proxy", line: "本机", platform: "通用", feature: "音频代理" },
    { id: "cover-proxy", line: "本机", platform: "通用", feature: "封面代理" },
];

const byId = new Map(
    [...SOURCE_CAPABILITIES, ...LOCAL_CAPABILITIES].map((item) => [item.id, item]),
);
const known = new Set(SOURCE_CAPABILITIES.map((item) => item.id));

const PROVIDER_ALIASES = {
    gdstudio: "lineA",
    qijieya: "lineB",
    vkeys: "lineC",
    openmusic: "lineD",
    bugpk: "lineE",
    netease: "lineF",
    injahow: "lineG",
    apicx: "lineH",
};
const ALIAS_TO_PROVIDER = Object.fromEntries(
    Object.entries(PROVIDER_ALIASES).map(([real, alias]) => [alias, real]),
);

let cached = { disabled: new Set(), mtimeMs: -1 };

function loadPolicy() {
    try {
        const stat = fs.statSync(POLICY_FILE);
        if (stat.mtimeMs === cached.mtimeMs) return cached;
        const parsed = JSON.parse(fs.readFileSync(POLICY_FILE, "utf8"));
        const disabled = new Set(Array.isArray(parsed.disabled) ? parsed.disabled.filter((id) => known.has(id)) : []);
        cached = { disabled, mtimeMs: stat.mtimeMs };
    } catch (error) {
        if (error.code !== "ENOENT") console.warn("[SourcePolicy] 配置读取失败，继续使用上一份有效配置:", error.message);
    }
    return cached;
}

export function isSourceEnabled(id) {
    return !loadPolicy().disabled.has(id);
}

export function filterEnabledSources(items) {
    return items.filter((item) => !item?.name || isSourceEnabled(item.name));
}

export function publicCapabilityLabel(id) {
    const item = byId.get(id);
    if (!item) return "未登记通道";
    const line = item.line === "本机" ? "本机" : `线路 ${item.line}`;
    return `${line} · ${item.platform} · ${item.feature}`;
}

export function devCapabilityLabel(id) {
    const item = byId.get(id);
    if (!item) return id;
    const upstream = SOURCE_LINES[item.line] || item.line;
    return `${upstream} · ${item.platform} · ${item.feature}`;
}

export function developerSourcePolicy() {
    const disabled = loadPolicy().disabled;
    return SOURCE_CAPABILITIES.map((item) => ({
        id: item.id,
        line: item.line,
        upstream: SOURCE_LINES[item.line] || item.line,
        platform: item.platform,
        feature: item.feature,
        publicLabel: publicCapabilityLabel(item.id),
        enabled: !disabled.has(item.id),
    }));
}

export function maskProviderName(name) {
    if (typeof name !== "string" || !name) return name;
    const cut = name.indexOf("-");
    const head = cut === -1 ? name : name.slice(0, cut);
    const alias = PROVIDER_ALIASES[head];
    if (!alias) return name;
    return cut === -1 ? alias : `${alias}${name.slice(cut)}`;
}

export function unmaskProviderName(name) {
    if (typeof name !== "string" || !name) return name;
    const cut = name.indexOf("-");
    const head = cut === -1 ? name : name.slice(0, cut);
    const real = ALIAS_TO_PROVIDER[head];
    if (!real) return name;
    return cut === -1 ? real : `${real}${name.slice(cut)}`;
}

export function maskProviderFields(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
    if (!("_provider" in payload) && !("_source" in payload) && !("_attemptedProviders" in payload)) return payload;
    const masked = { ...payload };
    if (typeof masked._provider === "string") masked._provider = maskProviderName(masked._provider);
    if (typeof masked._source === "string") masked._source = maskProviderName(masked._source);
    if (Array.isArray(masked._attemptedProviders)) {
        masked._attemptedProviders = masked._attemptedProviders.map(maskProviderName);
    }
    return masked;
}
