import axios from "axios";
import { isSourceEnabled, publicCapabilityLabel } from "./source-policy.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const PROBE_CACHE_TTL = 10 * 60 * 1000;
const _probeCache = new Map();

const DEFAULTS = {
    title: "起风了",
    artist: "买辣椒也用券",
    neteasePlaylistId: "3778678",
    tencentPlaylistId: "",
};

const GROUP_LABELS = {
    search: "搜索接口",
    song: "播放链接接口",
    lyric: "歌词接口",
    playlist: "歌单导入接口",
    proxy: "代理通道",
};

function maskSecret(str) {
    if (!str) return "";
    return String(str).replace(/(token=)[^&]+/gi, "$1***");
}

function describeHttp(s) {
    if (s === 401) return "未授权 (401)，token 可能已失效";
    if (s === 403) return "上游拒绝访问 (403)，可能已封禁外部调用";
    if (s === 404) return "接口不存在 (404)，路径可能已变更";
    if (s === 429) return "请求过于频繁 (429)，稍后重试";
    if (s >= 500) return `上游服务器错误 (${s})`;
    return `异常状态码 (${s})`;
}

function describeError(e) {
    const code = e.code || "";
    const status = e.response?.status;
    if (status) return describeHttp(status);
    if (code === "ECONNABORTED" || code === "ETIMEDOUT")
        return "请求超时，服务可能已停止响应";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN")
        return "域名解析失败，服务可能已下线";
    if (code === "ECONNREFUSED") return "连接被拒绝，端口未开放";
    if (code === "ECONNRESET") return "连接被重置，可能被中间设备阻断";
    if (code === "CERT_HAS_EXPIRED") return "HTTPS 证书已过期";
    if (code === "DEPTH_ZERO_SELF_SIGNED_CERT") return "HTTPS 证书不可信";
    if (code === "ERR_FR_TOO_MANY_REDIRECTS") return "重定向次数过多";
    return e.message || "未知错误";
}

function httpFail(r) {
    return { status: "fail", httpStatus: r.status, detail: describeHttp(r.status) };
}

function cacheProbeId(key, id) {
    if (!id) return;
    _probeCache.set(key, { id: String(id), ts: Date.now() });
}

function getProbeId(key) {
    const e = _probeCache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > PROBE_CACHE_TTL) {
        _probeCache.delete(key);
        return null;
    }
    return e.id;
}

function extractMetingId(item) {
    if (!item) return null;
    const direct = item.id || item.url_id || item.mid;
    if (direct) return String(direct);
    const match = String(item.url || "").match(/[?&]id=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
}

async function ensureQijieProbeId(cfg, source, query) {
    const featureId = `qijieya-${source}-search`;
    if (!isSourceEnabled(featureId)) return null;
    const key = `qijie:${source}`;
    const cached = getProbeId(key);
    if (cached) return cached;
    try {
        const r = await get(
            `${cfg.QIJIEYA_API}?server=${source}&type=search&id=${encodeURIComponent(query)}&page=1&limit=1`,
        );
        const item = Array.isArray(r.data) ? r.data[0] : null;
        const id = extractMetingId(item);
        if (id) {
            cacheProbeId(key, id);
            return id;
        }
    } catch (e) {}
    return null;
}

async function get(url, opts = {}) {
    return axios.get(url, {
        timeout: opts.timeout || 9000,
        headers: { "User-Agent": UA, ...(opts.headers || {}) },
        responseType: opts.responseType || "json",
        transformResponse: opts.transformResponse,
        validateStatus: () => true,
        maxRedirects: opts.maxRedirects === undefined ? 5 : opts.maxRedirects,
    });
}

async function post(url, body, opts = {}) {
    return axios.post(url, body, {
        timeout: opts.timeout || 15000,
        headers: { "User-Agent": UA, ...(opts.headers || {}) },
        validateStatus: () => true,
    });
}

async function probe(item) {
    const started = Date.now();
    try {
        const r = await item.run();
        return {
            name: item.name,
            label: item.label,
            endpoint: maskSecret(item.endpoint || ""),
            ms: Date.now() - started,
            status: r.status || "ok",
            httpStatus: r.httpStatus || 0,
            detail: r.detail || "",
            sample: r.sample || "",
        };
    } catch (e) {
        return {
            name: item.name,
            label: item.label,
            endpoint: maskSecret(item.endpoint || ""),
            ms: Date.now() - started,
            status: "fail",
            httpStatus: e.response?.status || 0,
            detail: describeError(e),
            sample: "",
        };
    }
}

function applySourcePolicy(items) {
    return items.map((item) =>
        item?.name && !isSourceEnabled(item.name)
            ? skipped(item.name, item.label, "维护者已停用此能力")
            : item,
    );
}

function skipped(name, label, reason) {
    return {
        name,
        label,
        endpoint: "",
        ms: 0,
        status: "skipped",
        httpStatus: 0,
        detail: reason,
        sample: "",
    };
}

async function ensureProbeId(cfg, source, query) {
    const cached = getProbeId(source);
    if (cached) return cached;
    if (source === "tencent" && isSourceEnabled("vkeys-tencent-search")) {
        try {
            const r = await get(
                `${cfg.VKEYS_TENCENT_SEARCH}?keyword=${encodeURIComponent(query)}&page=1&limit=1`,
            );
            const id =
                r.data?.code === 0 ? r.data?.data?.list?.[0]?.songID : null;
            if (id) {
                cacheProbeId(source, id);
                return String(id);
            }
        } catch (e) {}
    }
    if (isSourceEnabled(`gdstudio-${source}-search`)) try {
        const r = await get(
            `${cfg.GD_STUDIO_API}?types=search&source=${source}&name=${encodeURIComponent(query)}&count=1&pages=1`,
        );
        const id = Array.isArray(r.data) ? r.data[0]?.id : null;
        if (id) {
            cacheProbeId(source, id);
            return String(id);
        }
    } catch (e) {}
    if ((source === "netease" || source === "tencent") && isSourceEnabled(`qijieya-${source}-search`)) {
        try {
            const r = await get(
                `${cfg.QIJIEYA_API}?server=${source}&type=search&id=${encodeURIComponent(query)}&page=1&limit=1`,
            );
            const item = Array.isArray(r.data) ? r.data[0] : null;
            const id = item?.id || item?.url_id;
            if (id) {
                cacheProbeId(source, id);
                return String(id);
            }
        } catch (e) {}
    }
    if (source === "kuwo" && isSourceEnabled("openmusic-kuwo-search")) {
        try {
            const r = await get(
                `${cfg.OPEN_MUSIC_API_URL}?provider=kw&name=${encodeURIComponent(query)}&page=1&limit=1&token=${cfg.OPEN_MUSIC_API_TOKEN}`,
                { headers: { token: cfg.OPEN_MUSIC_API_TOKEN } },
            );
            const list = Array.isArray(r.data?.data)
                ? r.data.data
                : r.data?.data?.list || [];
            const id = list[0]?.rid || list[0]?.id;
            if (id) {
                cacheProbeId(source, id);
                return String(id);
            }
        } catch (e) {}
    }
    return null;
}

function isPlayableUrl(url) {
    if (!url || typeof url !== "string") return false;
    if (!url.startsWith("http")) return false;
    if (url.includes("版权") || url.includes("不存在")) return false;
    return true;
}

async function testPlayableUrl(url) {
    if (!isPlayableUrl(url)) return false;
    try {
        const r = await axios.get(url, {
            timeout: 10000,
            headers: {
                "User-Agent": UA,
                Referer: url.includes("qqmusic.qq.com")
                    ? "https://y.qq.com/"
                    : "https://www.google.com/",
                Range: "bytes=0-0",
            },
            responseType: "stream",
            validateStatus: () => true,
            maxRedirects: 5,
        });
        r.data.destroy();
        return (
            (r.status === 200 || r.status === 206) &&
            String(r.headers["content-type"] || "").startsWith("audio/") &&
            Number(r.headers["content-length"] || 0) !== 64
        );
    } catch (e) {
        return false;
    }
}

function buildSearchItems(cfg, q) {
    const kw = encodeURIComponent(q);
    return [
        ...(cfg.APICX_TOKEN
            ? [
                  {
                      name: "apicx-kuwo-search",
                      label: "残像API · 酷我搜索",
                      endpoint: cfg.APICX_KUWO,
                      run: async () => {
                          const r = await get(
                              cfg.APICX_KUWO + "?msg=" + kw + "&n=1",
                              {
                                  headers: { Authorization: cfg.APICX_TOKEN },
                                  timeout: 20000,
                              },
                          );
                          if (r.status !== 200) return httpFail(r);
                          const item = r.data?.data;
                          if (Number(r.data?.code) !== 200 || !item?.song_id)
                              return { status: "degraded", httpStatus: 200, detail: r.data?.msg || "可达但返回空结果" };
                          return { status: "ok", httpStatus: 200, sample: (item.name || "") + " · " + (item.singer || "") };
                      },
                  },
              ]
            : [skipped("apicx-kuwo-search", "残像API · 酷我搜索", "未填写 token")]),
        {
            name: "gdstudio-netease-search",
            label: "GDStudio · 网易云搜索",
            endpoint: cfg.GD_STUDIO_API,
            run: async () => {
                const r = await get(
                    `${cfg.GD_STUDIO_API}?types=search&source=netease&name=${kw}&count=5&pages=1`,
                );
                if (r.status !== 200) return httpFail(r);
                const list = Array.isArray(r.data) ? r.data : [];
                if (list.length === 0)
                    return { status: "degraded", httpStatus: 200, detail: "可达但返回空结果" };
                cacheProbeId("netease", list[0].id);
                return { status: "ok", httpStatus: 200, sample: `${list[0].name} · ${list.length} 条` };
            },
        },
        {
            name: "qijieya-netease-search",
            label: "祈杰 · 网易云搜索",
            endpoint: cfg.QIJIEYA_API,
            run: async () => {
                const r = await get(
                    `${cfg.QIJIEYA_API}?server=netease&type=search&id=${kw}&page=1&limit=5`,
                );
                if (r.status !== 200) return httpFail(r);
                let list = r.data;
                if (typeof list === "string") {
                    try {
                        list = JSON.parse(list);
                    } catch (e) {
                        list = [];
                    }
                }
                if (!Array.isArray(list) || list.length === 0)
                    return { status: "degraded", httpStatus: 200, detail: "可达但返回空结果" };
                const id = extractMetingId(list[0]);
                if (!id)
                    return { status: "degraded", httpStatus: 200, detail: "返回结果缺少歌曲 ID，无法用于播放" };
                cacheProbeId("qijie:netease", id);
                return { status: "ok", httpStatus: 200, sample: `${list[0].name || ""} · ${list.length} 条` };
            },
        },
        {
            name: "vkeys-tencent-search",
            label: "落月 API · QQ 音乐搜索",
            endpoint: cfg.VKEYS_TENCENT_SEARCH,
            run: async () => {
                const r = await get(
                    `${cfg.VKEYS_TENCENT_SEARCH}?keyword=${kw}&page=1&limit=5`,
                );
                if (r.status !== 200) return httpFail(r);
                const list =
                    r.data?.code === 0 && Array.isArray(r.data?.data?.list)
                        ? r.data.data.list
                        : [];
                if (list.length === 0)
                    return {
                        status: "degraded",
                        httpStatus: 200,
                        detail: r.data?.message || "可达但返回空结果",
                    };
                cacheProbeId("tencent", list[0].songID);
                return {
                    status: "ok",
                    httpStatus: 200,
                    sample: `${list[0].title || ""} · ${list.length} 条`,
                };
            },
        },
        {
            name: "qijieya-tencent-search",
            label: "祈杰 · QQ 音乐搜索",
            endpoint: cfg.QIJIEYA_API,
            run: async () => {
                const r = await get(
                    `${cfg.QIJIEYA_API}?server=tencent&type=search&id=${kw}&page=1&limit=5`,
                );
                if (r.status !== 200) return httpFail(r);
                let list = r.data;
                if (typeof list === "string") {
                    try {
                        list = JSON.parse(list);
                    } catch (e) {
                        list = [];
                    }
                }
                if (!Array.isArray(list) || list.length === 0)
                    return { status: "degraded", httpStatus: 200, detail: "可达但返回空结果" };
                const id = extractMetingId(list[0]);
                if (!id)
                    return { status: "degraded", httpStatus: 200, detail: "返回结果缺少歌曲 ID，无法用于播放" };
                cacheProbeId("qijie:tencent", id);
                return { status: "ok", httpStatus: 200, sample: `${list[0].name || ""} · ${list.length} 条` };
            },
        },
        {
            name: "openmusic-kuwo-search",
            label: "OpenMusic · 酷我搜索",
            endpoint: cfg.OPEN_MUSIC_API_URL,
            run: async () => {
                const r = await get(
                    `${cfg.OPEN_MUSIC_API_URL}?provider=kw&name=${kw}&page=1&limit=5&token=${cfg.OPEN_MUSIC_API_TOKEN}`,
                    { headers: { token: cfg.OPEN_MUSIC_API_TOKEN } },
                );
                if (r.status !== 200) return httpFail(r);
                if (r.data?.code !== 200)
                    return {
                        status: "degraded",
                        httpStatus: 200,
                        detail: `业务码异常 (code=${r.data?.code})，token 可能已过期`,
                    };
                const list = Array.isArray(r.data.data)
                    ? r.data.data
                    : r.data.data?.list || [];
                if (list.length === 0)
                    return { status: "degraded", httpStatus: 200, detail: "可达但返回空结果" };
                cacheProbeId("kuwo", list[0].rid || list[0].id);
                return { status: "ok", httpStatus: 200, sample: `${list[0].name || ""} · ${list.length} 条` };
            },
        },
        {
            name: "gdstudio-joox-search",
            label: "GDStudio · JOOX 搜索",
            endpoint: cfg.GD_STUDIO_API,
            run: async () => {
                const r = await get(
                    `${cfg.GD_STUDIO_API}?types=search&source=joox&name=${kw}&count=5&pages=1`,
                );
                if (r.status !== 200) return httpFail(r);
                const list = Array.isArray(r.data) ? r.data : [];
                if (list.length === 0)
                    return { status: "degraded", httpStatus: 200, detail: "可达但返回空结果" };
                cacheProbeId("joox", list[0].id);
                return { status: "ok", httpStatus: 200, sample: `${list[0].name} · ${list.length} 条` };
            },
        },
        {
            name: "gdstudio-kuwo-search",
            label: "GDStudio · 酷我搜索",
            endpoint: cfg.GD_STUDIO_API,
            run: async () => {
                const r = await get(
                    `${cfg.GD_STUDIO_API}?types=search&source=kuwo&name=${kw}&count=5&pages=1`,
                );
                if (r.status !== 200) return httpFail(r);
                const list = Array.isArray(r.data) ? r.data : [];
                if (list.length === 0)
                    return { status: "degraded", httpStatus: 200, detail: "可达但返回空结果" };
                cacheProbeId("kuwo", list[0].id);
                return { status: "ok", httpStatus: 200, sample: `${list[0].name} · ${list.length} 条` };
            },
        },
    ];
}

function buildSongItems(cfg, ids) {
    const items = [];
    const nid = ids.netease;
    const tid = ids.tencent;
    const qnid = ids.qijieNetease;
    const qtid = ids.qijieTencent;
    const kid = ids.kuwo;
    const jid = ids.joox;

    if (!nid) {
        items.push(skipped("gdstudio-netease-song", "GDStudio · 网易云播放链接", "未能取得网易云探针 ID"));
        items.push(skipped("bugpk-netease-song", "Bugpk · 网易云播放链接", "未能取得网易云探针 ID"));
        items.push(skipped("bugpk-aggregate-netease", "Bugpk 聚合 · 网易云播放链接", "未能取得网易云探针 ID"));
    } else {
        items.push({
            name: "gdstudio-netease-song",
            label: "GDStudio · 网易云播放链接",
            endpoint: cfg.GD_STUDIO_API,
            run: async () => {
                const r = await get(`${cfg.GD_STUDIO_API}?types=url&source=netease&id=${nid}&br=320`);
                if (r.status !== 200) return httpFail(r);
                if (!isPlayableUrl(r.data?.url))
                    return { status: "degraded", httpStatus: 200, detail: "未返回可播放链接，可能受版权限制" };
                return { status: "ok", httpStatus: 200, sample: new URL(r.data.url).hostname };
            },
        });
        items.push({
            name: "bugpk-netease-song",
            label: "Bugpk · 网易云播放链接",
            endpoint: cfg.BUGPK_NETEASE_SONG,
            run: async () => {
                const r = await get(`${cfg.BUGPK_NETEASE_SONG}?ids=${nid}&level=standard&type=json`);
                if (r.status !== 200) return httpFail(r);
                if (!isPlayableUrl(r.data?.url))
                    return {
                        status: "degraded",
                        httpStatus: 200,
                        detail: `未返回可播放链接 (status=${r.data?.status})`,
                    };
                return { status: "ok", httpStatus: 200, sample: new URL(r.data.url).hostname };
            },
        });
        items.push({
            name: "bugpk-aggregate-netease",
            label: "Bugpk 聚合 · 网易云播放链接",
            endpoint: cfg.BUGPK_AGGREGATE,
            run: async () => {
                const r = await get(`${cfg.BUGPK_AGGREGATE}?media=netease&type=song&id=${nid}`);
                if (r.status !== 200) return httpFail(r);
                if (!isPlayableUrl(r.data?.url))
                    return { status: "degraded", httpStatus: 200, detail: "未返回可播放链接" };
                return { status: "ok", httpStatus: 200, sample: new URL(r.data.url).hostname };
            },
        });
    }

    if (!qnid) {
        items.push(skipped("qijieya-netease-song", "祈杰 · 网易云播放链接", "未能从祈杰搜索结果取得网易云 ID"));
    } else {
        items.push({
            name: "qijieya-netease-song",
            label: "祈杰 · 网易云播放链接",
            endpoint: cfg.QIJIEYA_API,
            run: async () => {
                const r = await get(`${cfg.QIJIEYA_API}?server=netease&type=song&id=${encodeURIComponent(qnid)}`);
                if (r.status !== 200) return httpFail(r);
                let d = r.data;
                if (typeof d === "string") {
                    try {
                        d = JSON.parse(d);
                    } catch (e) {
                        d = null;
                    }
                }
                const url = Array.isArray(d) ? d[0]?.url : d?.url;
                if (!isPlayableUrl(url))
                    return { status: "degraded", httpStatus: 200, detail: "未返回可播放链接" };
                return { status: "ok", httpStatus: 200, sample: new URL(url).hostname };
            },
        });
    }

    if (cfg.APICX_TOKEN) {
        items.push({
            name: "apicx-kuwo-song",
            label: "残像API · 酷我播放链接",
            endpoint: cfg.APICX_KUWO,
            run: async () => {
                const r = await get(
                    cfg.APICX_KUWO + "?msg=" + encodeURIComponent(cfg.APICX_QUERY) + "&n=1",
                    { headers: { Authorization: cfg.APICX_TOKEN } },
                );
                if (r.status !== 200) return httpFail(r);
                const url = Number(r.data?.code) === 200 ? r.data?.data?.play_url : "";
                if (!isPlayableUrl(url))
                    return { status: "degraded", httpStatus: 200, detail: r.data?.msg || "未返回可播放链接" };
                if (!(await testPlayableUrl(url)))
                    return { status: "degraded", httpStatus: 200, detail: "返回了链接，但音频 CDN 已失效" };
                return { status: "ok", httpStatus: 200, sample: new URL(url).hostname };
            },
        });
    } else {
        items.push(skipped("apicx-kuwo-song", "残像API · 酷我播放链接", "未填写 token"));
    }

    if (!kid) {
        items.push(skipped("openmusic-kuwo-song", "OpenMusic · 酷我播放链接", "未能取得酷我探针 ID"));
        items.push(skipped("gdstudio-kuwo-song", "GDStudio · 酷我播放链接", "未能取得酷我探针 ID"));
    } else {
        items.push({
            name: "openmusic-kuwo-song",
            label: "OpenMusic · 酷我播放链接",
            endpoint: cfg.OPEN_MUSIC_API_URL,
            run: async () => {
                const r = await get(
                    `${cfg.OPEN_MUSIC_API_URL}?provider=kw&type=song&id=${kid}&format=json&level=exhigh&token=${cfg.OPEN_MUSIC_API_TOKEN}`,
                    { headers: { token: cfg.OPEN_MUSIC_API_TOKEN } },
                );
                if (r.status !== 200) return httpFail(r);
                if (r.data?.code !== 200)
                    return { status: "degraded", httpStatus: 200, detail: `业务码异常 (code=${r.data?.code})` };
                if (!isPlayableUrl(r.data?.data?.url))
                    return { status: "degraded", httpStatus: 200, detail: "未返回可播放链接" };
                return { status: "ok", httpStatus: 200, sample: new URL(r.data.data.url).hostname };
            },
        });
        items.push({
            name: "gdstudio-kuwo-song",
            label: "GDStudio · 酷我播放链接",
            endpoint: cfg.GD_STUDIO_API,
            run: async () => {
                const r = await get(`${cfg.GD_STUDIO_API}?types=url&source=kuwo&id=${kid}&br=320`);
                if (r.status !== 200) return httpFail(r);
                if (!isPlayableUrl(r.data?.url))
                    return { status: "degraded", httpStatus: 200, detail: "未返回可播放链接" };
                return { status: "ok", httpStatus: 200, sample: new URL(r.data.url).hostname };
            },
        });
    }

    if (!jid) {
        items.push(skipped("gdstudio-joox-song", "GDStudio · JOOX 播放链接", "未能取得 JOOX 探针 ID"));
    } else {
        items.push({
            name: "gdstudio-joox-song",
            label: "GDStudio · JOOX 播放链接",
            endpoint: cfg.GD_STUDIO_API,
            run: async () => {
                const r = await get(`${cfg.GD_STUDIO_API}?types=url&source=joox&id=${encodeURIComponent(jid)}&br=320`);
                if (r.status !== 200) return httpFail(r);
                if (!isPlayableUrl(r.data?.url))
                    return { status: "degraded", httpStatus: 200, detail: "未返回可播放链接，可能受版权或临时签名限制" };
                if (!(await testPlayableUrl(r.data.url)))
                    return { status: "degraded", httpStatus: 200, detail: "返回了链接，但音频 CDN 已失效" };
                return { status: "ok", httpStatus: 200, sample: new URL(r.data.url).hostname };
            },
        });
    }

    if (!tid) {
        items.push(skipped("vkeys-tencent-song", "落月 API · QQ 音乐播放链接", "未能取得 QQ 音乐探针 ID"));
    } else {
        items.push({
            name: "vkeys-tencent-song",
            label: "落月 API · QQ 音乐播放链接",
            endpoint: cfg.VKEYS_TENCENT_SONG,
            run: async () => {
                const r = await get(
                    `${cfg.VKEYS_TENCENT_SONG}?id=${encodeURIComponent(tid)}&quality=8`,
                );
                if (r.status !== 200) return httpFail(r);
                const url = [0, 200].includes(Number(r.data?.code))
                    ? r.data?.data?.url
                    : "";
                if (!isPlayableUrl(url))
                    return {
                        status: "degraded",
                        httpStatus: 200,
                        detail: r.data?.message || "未返回可播放链接",
                    };
                if (!(await testPlayableUrl(url)))
                    return {
                        status: "degraded",
                        httpStatus: 200,
                        detail: "返回了链接，但音频 CDN 已失效",
                    };
                return {
                    status: "ok",
                    httpStatus: 200,
                    sample: new URL(url).hostname,
                };
            },
        });
    }

    if (!qtid) {
        items.push(skipped("qijieya-tencent-song", "祈杰 · QQ 音乐播放链接", "未能从祈杰搜索结果取得 QQ 音乐 ID"));
    } else {
        items.push({
            name: "qijieya-tencent-song",
            label: "祈杰 · QQ 音乐播放链接",
            endpoint: cfg.QIJIEYA_API,
            run: async () => {
                const r = await get(`${cfg.QIJIEYA_API}?server=tencent&type=song&id=${encodeURIComponent(qtid)}`);
                if (r.status !== 200) return httpFail(r);
                let d = r.data;
                if (typeof d === "string") {
                    try {
                        d = JSON.parse(d);
                    } catch (e) {
                        d = null;
                    }
                }
                const url = Array.isArray(d) ? d[0]?.url : d?.url;
                if (!isPlayableUrl(url))
                    return { status: "degraded", httpStatus: 200, detail: "未返回可播放链接" };
                if (url.includes(".mp4"))
                    return { status: "degraded", httpStatus: 200, detail: "返回的是 mp4 视频流，播放器会跳过并换源" };
                return { status: "ok", httpStatus: 200, sample: new URL(url).hostname };
            },
        });
    }

    return items;
}

function buildLyricItems(cfg, ids, q) {
    const items = [];
    const nid = ids.netease;
    const qnid = ids.qijieNetease;
    const qtid = ids.qijieTencent;
    const kid = ids.kuwo;
    const jid = ids.joox;
    const textOpts = {
        responseType: "text",
        transformResponse: [(d) => d],
    };
    const looksLikeLrc = (s) =>
        typeof s === "string" && s.includes("[") && s.trim().length > 10;

    if (!qnid) {
        items.push(skipped("qijieya-netease-lyric", "祈杰 · 网易云歌词", "未能从祈杰搜索结果取得网易云 ID"));
    } else {
        items.push({
            name: "qijieya-netease-lyric",
            label: "祈杰 · 网易云歌词",
            endpoint: cfg.QIJIEYA_API,
            run: async () => {
                const r = await get(
                    `${cfg.QIJIEYA_API}?server=netease&type=lrc&id=${encodeURIComponent(qnid)}`,
                    textOpts,
                );
                if (r.status !== 200) return httpFail(r);
                if (!looksLikeLrc(r.data))
                    return { status: "degraded", httpStatus: 200, detail: "未返回有效 LRC 内容" };
                return { status: "ok", httpStatus: 200, sample: `${String(r.data).length} 字符` };
            },
        });
    }

    if (!nid) {
        items.push(skipped("bugpk-netease-lyric", "Bugpk · 网易云歌词", "未能取得网易云探针 ID"));
        items.push(skipped("gdstudio-netease-lyric", "GDStudio · 网易云歌词", "未能取得网易云探针 ID"));
    } else {
        items.push({
            name: "bugpk-netease-lyric",
            label: "Bugpk · 网易云歌词",
            endpoint: cfg.BUGPK_NETEASE_SONG,
            run: async () => {
                const r = await get(`${cfg.BUGPK_NETEASE_SONG}?ids=${nid}&level=standard&type=json`);
                if (r.status !== 200) return httpFail(r);
                if (!r.data?.lyric || String(r.data.lyric).trim() === "")
                    return { status: "degraded", httpStatus: 200, detail: "未返回歌词字段" };
                return {
                    status: "ok",
                    httpStatus: 200,
                    sample: r.data.tlyric ? "含翻译" : "仅原文",
                };
            },
        });
        items.push({
            name: "gdstudio-netease-lyric",
            label: "GDStudio · 网易云歌词",
            endpoint: cfg.GD_STUDIO_API,
            run: async () => {
                const r = await get(`${cfg.GD_STUDIO_API}?types=lyric&source=netease&id=${nid}`);
                if (r.status !== 200) return httpFail(r);
                if (!r.data?.lyric || String(r.data.lyric).trim() === "")
                    return { status: "degraded", httpStatus: 200, detail: "未返回歌词字段" };
                return {
                    status: "ok",
                    httpStatus: 200,
                    sample: r.data.tlyric ? "含翻译" : "仅原文",
                };
            },
        });
    }

    if (cfg.APICX_TOKEN) {
        items.push({
            name: "apicx-kuwo-lyric",
            label: "残像API · 酷我歌词",
            endpoint: cfg.APICX_KUWO,
            run: async () => {
                const r = await get(
                    cfg.APICX_KUWO + "?msg=" + encodeURIComponent(cfg.APICX_QUERY) + "&n=1",
                    { headers: { Authorization: cfg.APICX_TOKEN } },
                );
                if (r.status !== 200) return httpFail(r);
                const raw = r.data?.data?.lyrics?.raw;
                if (Number(r.data?.code) !== 200 || !Array.isArray(raw) || raw.length === 0)
                    return { status: "degraded", httpStatus: 200, detail: r.data?.msg || "未返回歌词内容" };
                return { status: "ok", httpStatus: 200, sample: raw.length + " 行歌词" };
            },
        });
    } else {
        items.push(skipped("apicx-kuwo-lyric", "残像API · 酷我歌词", "未填写 token"));
    }

    if (!kid) {
        items.push(skipped("openmusic-kuwo-lyr", "OpenMusic · 酷我歌词", "未能取得酷我探针 ID"));
        items.push(skipped("gdstudio-kuwo-lyric", "GDStudio · 酷我歌词", "未能取得酷我探针 ID"));
    } else {
        items.push({
            name: "openmusic-kuwo-lyr",
            label: "OpenMusic · 酷我歌词",
            endpoint: cfg.OPEN_MUSIC_API_URL,
            run: async () => {
                const r = await get(
                    `${cfg.OPEN_MUSIC_API_URL}?provider=kw&id=${kid}&type=lyr&format=all&token=${cfg.OPEN_MUSIC_API_TOKEN}`,
                    { headers: { token: cfg.OPEN_MUSIC_API_TOKEN } },
                );
                if (r.status !== 200) return httpFail(r);
                if (r.data?.code !== 200)
                    return { status: "degraded", httpStatus: 200, detail: `业务码异常 (code=${r.data?.code})` };
                const d = r.data.data || {};
                const has =
                    (typeof d.lrclist === "string" && d.lrclist.trim() !== "") ||
                    Array.isArray(d.defaultLrc) ||
                    Array.isArray(d.lrclist) ||
                    d.lyric ||
                    d.lrc;
                if (!has)
                    return { status: "degraded", httpStatus: 200, detail: "未返回歌词内容，播放器会走 song 接口兜底" };
                return { status: "ok", httpStatus: 200, sample: "已取得歌词" };
            },
        });
        items.push({
            name: "gdstudio-kuwo-lyric",
            label: "GDStudio · 酷我歌词",
            endpoint: cfg.GD_STUDIO_API,
            run: async () => {
                const r = await get(`${cfg.GD_STUDIO_API}?types=lyric&source=kuwo&id=${kid}`);
                if (r.status !== 200) return httpFail(r);
                if (!r.data?.lyric || String(r.data.lyric).trim() === "")
                    return { status: "degraded", httpStatus: 200, detail: "未返回歌词字段" };
                return { status: "ok", httpStatus: 200, sample: "已取得歌词" };
            },
        });
    }

    if (!jid) {
        items.push(skipped("gdstudio-joox-lyric", "GDStudio · JOOX 歌词", "未能取得 JOOX 探针 ID"));
    } else {
        items.push({
            name: "gdstudio-joox-lyric",
            label: "GDStudio · JOOX 歌词",
            endpoint: cfg.GD_STUDIO_API,
            run: async () => {
                const r = await get(`${cfg.GD_STUDIO_API}?types=lyric&source=joox&id=${encodeURIComponent(jid)}`);
                if (r.status !== 200) return httpFail(r);
                if (!r.data?.lyric || String(r.data.lyric).trim() === "")
                    return { status: "degraded", httpStatus: 200, detail: "未返回歌词字段" };
                return { status: "ok", httpStatus: 200, sample: "已取得歌词" };
            },
        });
    }

    if (!qtid) {
        items.push(skipped("qijieya-tencent-lyric", "祈杰 · QQ 音乐歌词", "未能从祈杰搜索结果取得 QQ 音乐 ID"));
    } else {
        items.push({
            name: "qijieya-tencent-lyric",
            label: "祈杰 · QQ 音乐歌词",
            endpoint: cfg.QIJIEYA_API,
            run: async () => {
                const r = await get(
                    `${cfg.QIJIEYA_API}?server=tencent&type=lrc&id=${encodeURIComponent(qtid)}`,
                    textOpts,
                );
                if (r.status !== 200) return httpFail(r);
                if (!looksLikeLrc(r.data))
                    return { status: "degraded", httpStatus: 200, detail: "未返回有效 LRC 内容" };
                return { status: "ok", httpStatus: 200, sample: `${String(r.data).length} 字符` };
            },
        });
    }

    items.push({
        name: "gdstudio-kw-by-name",
        label: "GDStudio · 按歌名兜底歌词",
        endpoint: cfg.GD_STUDIO_API,
        run: async () => {
            const s = await get(
                `${cfg.GD_STUDIO_API}?types=search&source=kuwo&name=${encodeURIComponent(q)}&count=1&pages=1`,
            );
            if (s.status !== 200) return httpFail(s);
            const sid = Array.isArray(s.data) ? s.data[0]?.id : null;
            if (!sid)
                return { status: "degraded", httpStatus: 200, detail: "兜底搜索无结果" };
            const r = await get(`${cfg.GD_STUDIO_API}?types=lyric&source=kuwo&id=${sid}`);
            if (r.status !== 200) return httpFail(r);
            if (!r.data?.lyric || String(r.data.lyric).trim() === "")
                return { status: "degraded", httpStatus: 200, detail: "兜底链路可达但无歌词" };
            return { status: "ok", httpStatus: 200, sample: "兜底链路正常" };
        },
    });

    return items;
}

function buildPlaylistItems(cfg, opts) {
    const nid = opts.neteasePlaylistId;
    const tid = opts.tencentPlaylistId;
    const neteaseHeaders = {
        Referer: "https://music.163.com",
        Cookie: "os=pc; appver=2.9.7",
        "Content-Type": "application/x-www-form-urlencoded",
    };
    const items = [
        {
            name: "netease-playlist-detail",
            label: "网易云直连 · 歌单详情 (v6)",
            endpoint: "https://music.163.com/api/v6/playlist/detail",
            run: async () => {
                const r = await post(
                    "https://music.163.com/api/v6/playlist/detail",
                    `id=${nid}&n=100000`,
                    { headers: neteaseHeaders, timeout: 20000 },
                );
                if (r.status !== 200) return httpFail(r);
                if (r.data?.code === 401)
                    return { status: "fail", httpStatus: 200, detail: "需要登录或无权限访问 (code=401)" };
                const pl = r.data?.playlist;
                if (!pl)
                    return { status: "fail", httpStatus: 200, detail: `未返回歌单数据 (code=${r.data?.code})` };
                const count = (pl.trackIds || []).length;
                return { status: "ok", httpStatus: 200, sample: `${pl.name || ""} · ${count} 首` };
            },
        },
        {
            name: "netease-song-detail",
            label: "网易云直连 · 批量歌曲详情 (v3)",
            endpoint: "https://music.163.com/api/v3/song/detail",
            run: async () => {
                const c = JSON.stringify([{ id: 1901371647 }, { id: 33894312 }]);
                const r = await post(
                    "https://music.163.com/api/v3/song/detail",
                    `c=${encodeURIComponent(c)}`,
                    { headers: neteaseHeaders, timeout: 20000 },
                );
                if (r.status !== 200) return httpFail(r);
                const songs = r.data?.songs || [];
                if (songs.length === 0)
                    return { status: "fail", httpStatus: 200, detail: "未返回歌曲详情，长歌单导入会失败" };
                return { status: "ok", httpStatus: 200, sample: `返回 ${songs.length} 首` };
            },
        },
        {
            name: "qijieya-netease-playlist",
            label: "祈杰 meting · 歌单导入",
            endpoint: cfg.QIJIEYA_API,
            run: async () => {
                const r = await get(
                    `${cfg.QIJIEYA_API}?server=netease&type=playlist&id=${nid}`,
                    { timeout: 15000 },
                );
                if (r.status !== 200) return httpFail(r);
                let list = r.data;
                if (typeof list === "string") {
                    try {
                        list = JSON.parse(list);
                    } catch (e) {
                        list = [];
                    }
                }
                if (!Array.isArray(list) || list.length === 0)
                    return { status: "degraded", httpStatus: 200, detail: "可达但返回空歌单" };
                return { status: "ok", httpStatus: 200, sample: `${list.length} 首` };
            },
        },
        {
            name: "injahow-netease-playlist",
            label: "injahow meting · 歌单导入",
            endpoint: "https://api.injahow.cn/meting/",
            run: async () => {
                const r = await get(
                    `https://api.injahow.cn/meting/?server=netease&type=playlist&id=${nid}`,
                    { timeout: 15000 },
                );
                if (r.status !== 200) return httpFail(r);
                let list = r.data;
                if (typeof list === "string") {
                    try {
                        list = JSON.parse(list);
                    } catch (e) {
                        list = [];
                    }
                }
                if (!Array.isArray(list) || list.length === 0)
                    return { status: "degraded", httpStatus: 200, detail: "可达但返回空歌单" };
                return { status: "ok", httpStatus: 200, sample: `${list.length} 首` };
            },
        },
    ];

    if (!tid) {
        items.push(
            skipped(
                "qijieya-tencent-playlist",
                "QQ 音乐 · 歌单导入",
                "未提供 QQ 音乐歌单 ID，可在诊断弹窗中填入后重测",
            ),
        );
    } else {
        items.push({
            name: "qijieya-tencent-playlist",
            label: "QQ 音乐 · 歌单导入",
            endpoint: cfg.QIJIEYA_API,
            run: async () => {
                const r = await get(
                    `${cfg.QIJIEYA_API}?server=tencent&type=playlist&id=${tid}`,
                    { timeout: 15000 },
                );
                if (r.status !== 200) return httpFail(r);
                let list = r.data;
                if (typeof list === "string") {
                    try {
                        list = JSON.parse(list);
                    } catch (e) {
                        list = [];
                    }
                }
                if (!Array.isArray(list) || list.length === 0)
                    return { status: "degraded", httpStatus: 200, detail: "可达但返回空歌单" };
                return { status: "ok", httpStatus: 200, sample: `${list.length} 首` };
            },
        });
    }

    return items;
}

function buildProxyItems(cfg, ids, q) {
    const nid = ids.netease;
    return [
        {
            name: "stream-proxy",
            label: "音频代理通道 (stream)",
            endpoint: "内部路由 /stream",
            run: async () => {
                if (!nid)
                    return { status: "degraded", httpStatus: 0, detail: "无可用探针 ID，未能验证" };
                const u = await get(`${cfg.GD_STUDIO_API}?types=url&source=netease&id=${nid}&br=320`);
                const audioUrl = u.data?.url;
                if (!isPlayableUrl(audioUrl))
                    return { status: "degraded", httpStatus: 0, detail: "未取得音频链接，无法验证代理" };
                let referer = "https://www.google.com/";
                if (audioUrl.includes("music.126.net")) referer = "https://music.163.com/";
                else if (audioUrl.includes("qqmusic.qq.com")) referer = "https://y.qq.com/";
                else if (audioUrl.includes("kuwo.cn")) referer = "https://www.kuwo.cn/";
                const r = await axios.get(audioUrl, {
                    timeout: 12000,
                    headers: { "User-Agent": UA, Referer: referer, Range: "bytes=0-2047" },
                    responseType: "arraybuffer",
                    validateStatus: () => true,
                    maxRedirects: 5,
                });
                if (r.status !== 200 && r.status !== 206) return httpFail(r);
                const len = r.data?.byteLength || 0;
                if (len === 0)
                    return { status: "degraded", httpStatus: r.status, detail: "上游返回空内容，音频可能无法播放" };
                return {
                    status: "ok",
                    httpStatus: r.status,
                    sample: `${len} 字节 · ${r.headers["content-type"] || "未知类型"}`,
                };
            },
        },
        {
            name: "cover-proxy",
            label: "封面代理通道 (cover-proxy)",
            endpoint: "内部路由 /cover-proxy",
            run: async () => {
                const s = await get(
                    `${cfg.GD_STUDIO_API}?types=search&source=netease&name=${encodeURIComponent(q)}&count=1&pages=1`,
                );
                const picId = Array.isArray(s.data) ? s.data[0]?.pic_id : null;
                if (!picId)
                    return { status: "degraded", httpStatus: 0, detail: "未取得封面 ID，无法验证代理" };
                const p = await get(
                    `${cfg.GD_STUDIO_API}?types=pic&source=netease&id=${encodeURIComponent(picId)}&size=500`,
                );
                const realUrl = p.data?.url;
                if (!realUrl || !String(realUrl).startsWith("http"))
                    return { status: "degraded", httpStatus: 200, detail: "封面解析接口未返回图片地址" };
                const img = await axios.get(realUrl, {
                    timeout: 12000,
                    headers: { "User-Agent": UA, Referer: "https://music.163.com/" },
                    responseType: "arraybuffer",
                    validateStatus: () => true,
                    maxRedirects: 5,
                });
                if (img.status !== 200) return httpFail(img);
                const ct = img.headers["content-type"] || "";
                if (!ct.startsWith("image/"))
                    return { status: "degraded", httpStatus: 200, detail: `返回内容不是图片 (${ct})` };
                return {
                    status: "ok",
                    httpStatus: 200,
                    sample: `${Math.round((img.data?.byteLength || 0) / 1024)} KB · ${ct}`,
                };
            },
        },
    ];
}

const ENUM_IDS = {
    netease: "probe",
    kuwo: "probe",
    joox: "probe",
    tencent: "probe",
    qijieNetease: "probe",
    qijieTencent: "probe",
};

export const DIAGNOSE_GROUPS = { ...GROUP_LABELS };
export const DIAGNOSE_DEFAULTS = { ...DEFAULTS };

function normalizeOptions(opts) {
    const title = String(opts.title || "").trim();
    const artist = String(opts.artist || "").trim();
    return {
        query: (title ? `${title} ${artist}` : `${DEFAULTS.title} ${DEFAULTS.artist}`).trim(),
        neteasePlaylistId:
            String(opts.neteasePlaylistId || "").trim() || DEFAULTS.neteasePlaylistId,
        tencentPlaylistId: String(opts.tencentPlaylistId || "").trim(),
        only: opts.only ? new Set(opts.only) : null,
        ignorePolicy: opts.ignorePolicy === true,
    };
}

async function resolveProbeIds(cfg, query) {
    return {
        netease: await ensureProbeId(cfg, "netease", query),
        kuwo: await ensureProbeId(cfg, "kuwo", query),
        joox: await ensureProbeId(cfg, "joox", query),
        tencent: await ensureProbeId(cfg, "tencent", query),
        qijieNetease: await ensureQijieProbeId(cfg, "netease", query),
        qijieTencent: await ensureQijieProbeId(cfg, "tencent", query),
    };
}

async function buildGroupItems(cfg, group, opts) {
    switch (group) {
        case "search":
            return buildSearchItems(cfg, opts.query);
        case "song":
            return buildSongItems(cfg, await resolveProbeIds(cfg, opts.query));
        case "lyric":
            return buildLyricItems(cfg, await resolveProbeIds(cfg, opts.query), opts.query);
        case "playlist":
            return buildPlaylistItems(cfg, opts);
        case "proxy":
            return buildProxyItems(
                cfg,
                { netease: await ensureProbeId(cfg, "netease", opts.query) },
                opts.query,
            );
        default:
            return [];
    }
}

export function diagnoseCapabilityGroups(cfg) {
    const map = new Map([
        ["apicx-kuwo-search", "search"],
        ["apicx-kuwo-song", "song"],
        ["apicx-kuwo-lyric", "lyric"],
    ]);
    const add = (group, items) => {
        for (const item of items) {
            if (item?.name && !map.has(item.name)) map.set(item.name, group);
        }
    };
    add("search", buildSearchItems(cfg, "probe"));
    add("song", buildSongItems(cfg, ENUM_IDS));
    add("lyric", buildLyricItems(cfg, ENUM_IDS, "probe"));
    add("playlist", buildPlaylistItems(cfg, {
        neteasePlaylistId: DEFAULTS.neteasePlaylistId,
        tencentPlaylistId: "probe",
    }));
    add("proxy", buildProxyItems(cfg, ENUM_IDS, "probe"));
    return map;
}

export async function runDiagnoseGroup(cfg, group, options = {}) {
    if (!GROUP_LABELS[group]) throw new Error(`未知的诊断分组: ${group}`);
    const opts = normalizeOptions(options);
    const runtimeConfig = {
        ...cfg,
        APICX_TOKEN: String(options.apicxToken || "").trim(),
        APICX_QUERY: opts.query,
    };
    let items = await buildGroupItems(runtimeConfig, group, opts);
    if (opts.only) items = items.filter((item) => opts.only.has(item.name));
    if (!opts.ignorePolicy) items = applySourcePolicy(items);
    const results = [];
    for (const item of items) {
        results.push(item.status ? item : await probe(item));
    }
    return results;
}

function sanitizePublicText(text) {
    if (!text) return "";
    return String(text)
        .replace(/https?:\/\/\S+/gi, "上游地址")
        .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, "上游地址");
}

function toPublicItem(item) {
    return {
        label: publicCapabilityLabel(item.name),
        status: item.status,
        ms: item.ms,
        detail: sanitizePublicText(item.detail),
        sample: sanitizePublicText(item.sample),
    };
}

export function registerDiagnoseRoutes(router, API_CONFIG) {
    router.post("/diagnose", async (req, res) => {
        const body = req.body || {};
        const group = String(body.group || "search");
        if (!GROUP_LABELS[group]) {
            return res.status(400).json({ error: "未知的诊断分组" });
        }

        const startedAt = Date.now();
        try {
            const results = await runDiagnoseGroup(API_CONFIG, group, body);
            res.json({
                group,
                groupLabel: GROUP_LABELS[group],
                startedAt: new Date(startedAt).toISOString(),
                durationMs: Date.now() - startedAt,
                items: results.map(toPublicItem),
            });
        } catch (e) {
            console.error("[Diagnose] 执行失败:", e);
            res.status(500).json({ error: "诊断执行失败，请查看服务端日志" });
        }
    });

    router.get("/diagnose/groups", (req, res) => {
        res.json({
            groups: Object.keys(GROUP_LABELS).map((k) => ({
                key: k,
                label: GROUP_LABELS[k],
            })),
            defaults: {
                title: DEFAULTS.title,
                artist: DEFAULTS.artist,
                neteasePlaylistId: DEFAULTS.neteasePlaylistId,
            },
        });
    });

    console.log("[G-Player Proxy] ✓ 诊断模块已加载");
}
