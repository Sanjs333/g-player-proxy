import axios from "axios";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { registerDiagnoseRoutes } from "./diagnose.js";
import {
    addProviderMetadata,
    createApiHealth,
    parseExcludeProviders,
    tryProviderChain,
} from "./provider-chain.js";
import { API_CONFIG } from "./api-config.js";
import {
    filterEnabledSources,
    isSourceEnabled,
    maskProviderFields,
    unmaskProviderName,
} from "./source-policy.js";

export const info = {
    id: "g-player-proxy",
    name: "G-Player Music Proxy",
    description: "为 G-Player 音乐播放器提供多音源代理支持。",
};


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLAYLIST_FILE = path.join(__dirname, "playlists.json");

const ApiHealth = createApiHealth();

function loadPlaylists() {
    try {
        if (!fs.existsSync(PLAYLIST_FILE)) {
            return { playlists: [] };
        }
        const data = fs.readFileSync(PLAYLIST_FILE, "utf-8");
        const parsed = JSON.parse(data);
        if (!parsed || !Array.isArray(parsed.playlists)) {
            return { playlists: [] };
        }
        return parsed;
    } catch (e) {
        console.error("[Playlists] 读取失败:", e.message);
        return { playlists: [] };
    }
}

function savePlaylists(data) {
    try {
        fs.writeFileSync(PLAYLIST_FILE, JSON.stringify(data, null, 2), "utf-8");
        return true;
    } catch (e) {
        console.error("[Playlists] 写入失败:", e.message);
        return false;
    }
}

function genPlaylistId() {
    return (
        "pl_" +
        Date.now().toString(36) +
        "_" +
        Math.random().toString(36).slice(2, 8)
    );
}

function songKey(s) {
    return (
        (s?.title || "").toLowerCase().trim() +
        "|" +
        (s?.artist || "").toLowerCase().trim()
    );
}

async function resolvePlaylistUrl(input) {
    if (!input || typeof input !== "string") return null;

    const urlMatch = input.match(/https?:\/\/[^\s"'<>，,]+/);
    if (!urlMatch) return null;
    let url = urlMatch[0];

    const isShortLink =
        /c\.y\.qq\.com|c6\.y\.qq\.com|fcgi-bin\/u|163cn\.tv/i.test(url);

    if (isShortLink) {
        try {
            const resp = await axios.get(url, {
                maxRedirects: 5,
                timeout: 10000,
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
                },
                validateStatus: (s) => s >= 200 && s < 400,
            });
            const finalUrl = resp.request?.res?.responseUrl;
            if (finalUrl) {
                url = finalUrl;
            } else if (typeof resp.data === "string") {
                const htmlId =
                    resp.data.match(/playlist[\/=](\d{6,})/i) ||
                    resp.data.match(/dissid[^0-9]*(\d{6,})/i) ||
                    resp.data.match(/"id"\s*:\s*"?(\d{8,})"?/);
                if (htmlId) {
                    return { server: "tencent", id: htmlId[1] };
                }
            }
        } catch (e) {
            console.warn("[Playlists] 短链解析失败:", e.message);
        }
    }

    let match = url.match(/music\.163\.com[^\s]*?[?&#\/]id=(\d+)/i);
    if (match) return { server: "netease", id: match[1] };
    match = url.match(/music\.163\.com\/playlist\/(\d+)/i);
    if (match) return { server: "netease", id: match[1] };

    match = url.match(/y\.qq\.com\/[^\s]*?playlist\/(\d+)/i);
    if (match) return { server: "tencent", id: match[1] };
    match = url.match(/y\.qq\.com\/[^\s]*?[?&]id=(\d+)/i);
    if (match) return { server: "tencent", id: match[1] };
    match = url.match(/taoge[^\s]*?[?&]id=(\d+)/i);
    if (match) return { server: "tencent", id: match[1] };
    match = url.match(/qq\.com\/[^\s]*?[?&]id=(\d+)/i);
    if (match) return { server: "tencent", id: match[1] };

    return null;
}

async function fetchNeteasePlaylistFull(id) {
    if (!isSourceEnabled("netease-playlist-detail")) return null;
    const headers = {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://music.163.com",
        Cookie: "os=pc; appver=2.9.7",
        "Content-Type": "application/x-www-form-urlencoded",
    };

    try {
        const detailResp = await axios.post(
            "https://music.163.com/api/v6/playlist/detail",
            `id=${id}&n=100000`,
            { timeout: 20000, headers },
        );

        if (detailResp.data?.code === 401) {
            console.warn("[Playlists] 网易云歌单需要登录或无权限访问");
            return null;
        }

        const playlist = detailResp.data?.playlist;
        if (!playlist) {
            console.warn(
                "[Playlists] 网易云未返回 playlist 字段, code:",
                detailResp.data?.code,
            );
            return null;
        }

        const trackIds = (playlist.trackIds || [])
            .map((t) => t.id)
            .filter(Boolean);

        if (trackIds.length === 0) {
            const tracks = playlist.tracks || [];
            if (tracks.length === 0) return null;
            return tracks
                .map((s) => {
                    if (!s.name) return null;
                    return {
                        title: String(s.name).trim(),
                        artist: Array.isArray(s.ar)
                            ? s.ar
                                  .map((a) => a.name)
                                  .filter(Boolean)
                                  .join(", ")
                            : "",
                        cover: s.al?.picUrl || "",
                    };
                })
                .filter(Boolean);
        }

        const BATCH_SIZE = 400;
        const allSongs = [];
        const totalBatches = Math.ceil(trackIds.length / BATCH_SIZE);

        if (!isSourceEnabled("netease-song-detail")) return null;

        for (let i = 0; i < trackIds.length; i += BATCH_SIZE) {
            const batch = trackIds.slice(i, i + BATCH_SIZE);
            const cJson = JSON.stringify(batch.map((tid) => ({ id: tid })));

            try {
                const songResp = await axios.post(
                    "https://music.163.com/api/v3/song/detail",
                    `c=${encodeURIComponent(cJson)}`,
                    { timeout: 25000, headers },
                );

                const songs = songResp.data?.songs || [];
                songs.forEach((s) => {
                    if (!s.name) return;
                    allSongs.push({
                        title: String(s.name).trim(),
                        artist: Array.isArray(s.ar)
                            ? s.ar
                                  .map((a) => a.name)
                                  .filter(Boolean)
                                  .join(", ")
                            : "",
                        cover: s.al?.picUrl || "",
                    });
                });
            } catch (e) {
                console.warn(
                    `[Playlists] 批次 ${Math.floor(i / BATCH_SIZE) + 1}/${totalBatches} 获取失败:`,
                    e.message,
                );
            }
        }

        if (allSongs.length > 0) {
        }

        return allSongs.length > 0 ? allSongs : null;
    } catch (e) {
        console.warn("[Playlists] 网易云直连API失败:", e.message);
        return null;
    }
}

async function importPlaylistFromApi(server, id) {
    if (server === "netease") {
        const songs = await fetchNeteasePlaylistFull(id);
        if (songs && songs.length > 0) {
            return songs;
        }
    }

    const apis = [
        { name: `qijieya-${server}-playlist`, url: `https://api.qijieya.cn/meting/?server=${server}&type=playlist&id=${id}` },
        { name: `injahow-${server}-playlist`, url: `https://api.injahow.cn/meting/?server=${server}&type=playlist&id=${id}` },
    ];

    for (const api of apis) {
        if (!isSourceEnabled(api.name)) continue;
        const url = api.url;
        try {
            const resp = await axios.get(url, {
                timeout: 15000,
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                },
            });
            let raw = resp.data;
            if (typeof raw === "string") {
                try {
                    raw = JSON.parse(raw);
                } catch (e) {}
            }
            if (!Array.isArray(raw) || raw.length === 0) continue;

            const songs = raw
                .map((item) => {
                    const title = item.name || item.title || item.song || "";
                    if (!title) return null;
                    let artist = item.artist || item.singer || "";
                    if (Array.isArray(artist)) artist = artist.join(", ");
                    return {
                        title: String(title).trim(),
                        artist: String(artist).trim(),
                        cover: item.pic || item.cover || "",
                    };
                })
                .filter(Boolean);

            if (songs.length > 0) {
                return songs;
            }
        } catch (e) {
            console.warn(`[Playlists] API ${url} 失败:`, e.message);
            continue;
        }
    }
    return null;
}

function getAudioMimeType(url) {
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.includes(".mp3")) return "audio/mpeg";
    if (lowerUrl.includes(".m4a")) return "audio/mp4";
    if (lowerUrl.includes(".flac")) return "audio/flac";
    if (lowerUrl.includes(".ogg")) return "audio/ogg";
    if (lowerUrl.includes(".wav")) return "audio/wav";
    if (lowerUrl.includes("qqmusic.qq.com")) return "audio/mp4";
    if (lowerUrl.includes("kuwo.cn")) return "audio/mpeg";
    if (lowerUrl.includes("music.126.net")) return "audio/mpeg";
    return "audio/mpeg";
}

function convertLrclistToLrc(lrclist) {
    if (!lrclist) return "";
    if (typeof lrclist === "string") return lrclist;
    if (!Array.isArray(lrclist)) return "";
    return lrclist
        .map((item) => {
            const time = parseFloat(item.time) || 0;
            const minutes = Math.floor(time / 60);
            const seconds = (time % 60).toFixed(2);
            const text = item.lineLyric || item.text || "";
            return `[${String(minutes).padStart(2, "0")}:${seconds.padStart(5, "0")}]${text}`;
        })
        .join("\n");
}

async function validatePlayableUrl(url) {
    if (!url || typeof url !== "string" || !url.startsWith("http")) {
        return false;
    }
    try {
        const response = await axios.get(url, {
            timeout: 10000,
            maxRedirects: 5,
            responseType: "stream",
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                Referer: url.includes("qqmusic.qq.com")
                    ? "https://y.qq.com/"
                    : "https://www.google.com/",
                Range: "bytes=0-0",
            },
            validateStatus: (status) => status === 200 || status === 206,
        });
        response.data.destroy();
        const contentType = response.headers["content-type"] || "";
        return (
            contentType.startsWith("audio/") &&
            Number(response.headers["content-length"] || 0) !== 64
        );
    } catch (e) {
        throw e;
    }
}

const UPSTREAM_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

const TRACK_PUNCTUATION = new Set([
    ..."()[]{}.,!?;:_-/",
    ...String.fromCharCode(34, 39, 92),
    ...String.fromCharCode(0x2013, 0x2014, 0x00b7, 0x30fb),
    ...String.fromCharCode(0x300a, 0x300b, 0x3010, 0x3011),
    ...String.fromCharCode(0x300c, 0x300d, 0x300e, 0x300f),
    ...String.fromCharCode(0xff08, 0xff09, 0x3002, 0xff0c),
    ...String.fromCharCode(0xff01, 0xff1f, 0xff1b, 0xff1a),
    ...String.fromCharCode(0x201c, 0x201d, 0x2018, 0x2019),
]);

const APICX_TOKEN_ALPHABET = new Set([
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    ..."abcdefghijklmnopqrstuvwxyz",
    ..."0123456789._~+=-",
    ...String.fromCharCode(47),
]);

function upstreamHeaders(api) {
    const headers = { "User-Agent": UPSTREAM_USER_AGENT };
    if (
        typeof api.url === "string" &&
        api.url.startsWith(API_CONFIG.OPEN_MUSIC_API_URL)
    ) {
        headers.token = API_CONFIG.OPEN_MUSIC_API_TOKEN;
    }
    return { ...headers, ...(api.headers || {}) };
}

function normalizeTrackText(value) {
    const text = String(value || "")
        .normalize("NFKC")
        .toLowerCase();
    let out = "";
    for (const ch of text) {
        const code = ch.codePointAt(0);
        if (code <= 0x20 || code === 0x3000) continue;
        if (TRACK_PUNCTUATION.has(ch)) continue;
        out += ch;
    }
    return out;
}

function isTrackNameMatch(wantTitle, wantArtist, gotTitle, gotArtist) {
    const want = normalizeTrackText(wantTitle);
    const got = normalizeTrackText(gotTitle);
    if (!want || !got) return false;
    if (!got.includes(want) && !want.includes(got)) return false;
    const wantBy = normalizeTrackText(wantArtist);
    if (!wantBy) return true;
    const gotBy = normalizeTrackText(gotArtist);
    if (!gotBy) return false;
    return gotBy.includes(wantBy) || wantBy.includes(gotBy);
}

function readApicxToken(req) {
    const token = String(
        req.get("x-apicx-token") || req.query.apicxToken || "",
    ).trim();
    if (token.length < 8 || token.length > 256) return "";
    for (const ch of token) {
        if (!APICX_TOKEN_ALPHABET.has(ch)) return "";
    }
    return token;
}

function classifyApicxError(error) {
    const payload = error?.response?.data;
    let message = "";
    if (typeof payload === "string") {
        try {
            const parsed = JSON.parse(payload);
            message = parsed?.msg || parsed?.message || "";
        } catch {
            message = payload;
        }
    } else if (payload && typeof payload === "object") {
        message = payload.msg || payload.message || "";
    }
    message = String(message || "").trim();
    if (/密钥无效|token.*(?:无效|错误|过期)|(?:invalid|expired).*token/i.test(message)) {
        return { kind: "unavailable", reason: "invalid_token", message: "token 无效或已过期" };
    }
    if (/请输入.*token|缺少.*token|missing.*token/i.test(message)) {
        return { kind: "unavailable", reason: "missing_token", message: "未提供 token" };
    }
    if (/未找到|没有找到|无结果|not found|no result/i.test(message)) {
        return { kind: "unavailable", reason: "not_found", message: "没有找到匹配歌曲" };
    }
    return null;
}

function apicxKuwoRequest(token, title, artist) {
    const msg = [title, artist].filter(Boolean).join(" ").trim();
    return {
        url: `${API_CONFIG.APICX_KUWO}?msg=${encodeURIComponent(msg)}&n=1`,
        headers: { Authorization: token },
    };
}

function apicxKuwoTrack(data, title, artist) {
    if (Number(data?.code) !== 200) return null;
    const item = data.data;
    if (!item || typeof item !== "object") return null;
    if (!isTrackNameMatch(title, artist, item.name, item.singer)) return null;
    return item;
}

function apicxKuwoSearchApis({ token, query }) {
    if (!token || !query) return [];
    const { url, headers } = apicxKuwoRequest(token, query, "");
    return [
        {
            name: "apicx-kuwo-search",
            url,
            headers,
            classifyError: classifyApicxError,
            transform: (data) => {
                if (Number(data?.code) !== 200) return null;
                const item = data.data;
                if (!item || typeof item !== "object" || !item.song_id) {
                    return null;
                }
                return {
                    data: [
                        {
                            id: String(item.song_id),
                            song: item.name || "",
                            singer: item.singer || "",
                            cover: item.cover || "",
                            album: item.album || "",
                            time: item.duration || "",
                        },
                    ],
                };
            },
        },
    ];
}

function apicxKuwoSongApis({ token, title, artist }) {
    if (!token || !title) return [];
    const { url, headers } = apicxKuwoRequest(token, title, artist);
    return [
        {
            name: "apicx-kuwo-song",
            url,
            headers,
            classifyError: classifyApicxError,
            transform: (data) => {
                const item = apicxKuwoTrack(data, title, artist);
                const playUrl = item?.play_url;
                if (
                    typeof playUrl !== "string" ||
                    !playUrl.startsWith("http")
                ) {
                    return null;
                }
                return {
                    data: {
                        url: playUrl,
                        lrc: convertLrclistToLrc(item.lyrics?.raw) || "",
                    },
                    _source: "apicx-kuwo",
                };
            },
            validate: (transformed) =>
                validatePlayableUrl(transformed?.data?.url),
        },
    ];
}

function apicxKuwoLyricApis({ token, title, artist }) {
    if (!token || !title) return [];
    const { url, headers } = apicxKuwoRequest(token, title, artist);
    return [
        {
            name: "apicx-kuwo-lyric",
            url,
            headers,
            classifyError: classifyApicxError,
            transform: (data) => {
                const item = apicxKuwoTrack(data, title, artist);
                const lrc = convertLrclistToLrc(item?.lyrics?.raw);
                if (!lrc || lrc.trim() === "") return null;
                return {
                    data: { lrc, tlyric: "" },
                    _source: "apicx-kuwo",
                };
            },
        },
    ];
}

async function tryMultipleAPIs(apis, options = {}) {
    const chainResult = await tryProviderChain({
        apis: filterEnabledSources(apis),
        excludeProviders: options.excludeProviders,
        emptyIsFailure: options.emptyIsFailure ?? true,
        health: ApiHealth,
        request: async (api) => {
            let lastError;
            const attempts = Math.max(1, Math.min(3, Number(api.attempts) || 1));
            for (let attempt = 0; attempt < attempts; attempt++) {
                try {
                    return await axios.get(api.url, {
                        maxRedirects: 5,
                        headers: upstreamHeaders(api),
                        timeout: api.timeout || 15000,
                    });
                } catch (error) {
                    lastError = error;
                }
            }
            throw lastError;
        },
    });
    return options.detailed ? chainResult : chainResult.result;
}

export async function init(router) {
    router.use(express.json({ limit: "10mb" }));
    router.use((req, res, next) => {
        const sendJson = res.json.bind(res);
        res.json = (payload) => sendJson(maskProviderFields(payload));
        next();
    });
    router.get("/search", async (req, res) => {
        try {
            const query = req.query.query;
            const source = req.query.source || "tencent";
            const page = Math.max(1, parseInt(req.query.page) || 1);
            const apicxToken = readApicxToken(req);
            if (!query) {
                return res
                    .status(400)
                    .json({ error: "Missing query parameter" });
            }
            let result = null;
            switch (source) {
                case "netease":
                    result = await tryMultipleAPIs([
                        {
                            name: "gdstudio-netease-search",
                            url: `${API_CONFIG.GD_STUDIO_API}?types=search&source=netease&name=${encodeURIComponent(query)}&count=30&pages=${page}`,
                            transform: (data) => {
                                if (Array.isArray(data) && data.length > 0) {
                                    return {
                                        data: data.map((item) => ({
                                            id: item.id,
                                            song: item.name,
                                            singer: Array.isArray(item.artist)
                                                ? item.artist.join(", ")
                                                : item.artist,
                                            cover: item.pic_id
                                                ? `/api/plugins/g-player-proxy/cover-proxy?provider=gdstudio&source=netease&id=${item.pic_id}&size=500`
                                                : "",
                                            pic_id: item.pic_id || "",
                                            lyric_id: item.lyric_id || item.id,
                                            album: item.album || "",
                                            time: item.time || "",
                                        })),
                                    };
                                }
                                return null;
                            },
                        },
                        {
                            name: "qijieya-netease-search",
                            url: `${API_CONFIG.QIJIEYA_API}?server=netease&type=search&id=${encodeURIComponent(query)}&page=${page}&limit=30`,
                            transform: (data) => {
                                if (Array.isArray(data) && data.length > 0) {
                                    return {
                                        data: data.map((item) => {
                                            const artistRaw = item.artist;
                                            const artist = Array.isArray(
                                                artistRaw,
                                            )
                                                ? artistRaw.join(", ")
                                                : artistRaw || "";
                                            const urlStr = item.url || "";
                                            const idMatch =
                                                urlStr.match(/[?&]id=([^&]+)/);
                                            const extractedId = idMatch
                                                ? idMatch[1]
                                                : "";
                                            const songIdStr = String(
                                                item.id ||
                                                    item.url_id ||
                                                    extractedId ||
                                                    "",
                                            );
                                            const rawPic =
                                                item.pic || item.cover || "";
                                            const picIdMatch =
                                                rawPic.match(/[?&]id=([^&]+)/);
                                            const coverProxyId = picIdMatch
                                                ? picIdMatch[1]
                                                : songIdStr;
                                            return {
                                                id: songIdStr,
                                                song:
                                                    item.name ||
                                                    item.title ||
                                                    "",
                                                singer: artist,
                                                cover: coverProxyId
                                                    ? `/api/plugins/g-player-proxy/cover-proxy?provider=qijieya&source=netease&id=${encodeURIComponent(coverProxyId)}`
                                                    : "",
                                                lyric_id:
                                                    item.lyric_id ||
                                                    item.id ||
                                                    "",
                                                album: item.album || "",
                                                time: item.time || "",
                                            };
                                        }),
                                    };
                                }
                                return null;
                            },
                            validate: (transformed) => {
                                return !!transformed?.data?.[0]?.id;
                            },
                        },
                    ]);
                    break;
                case "kuwo":
                    result = await tryMultipleAPIs([
                        ...apicxKuwoSearchApis({
                            token: apicxToken,
                            query,
                        }).map((api) => ({ ...api, attempts: 2, timeout: 25000 })),
                        {
                            name: "openmusic-kuwo-search",
                            url: `${API_CONFIG.OPEN_MUSIC_API_URL}?provider=kw&name=${encodeURIComponent(query)}&page=${page}&limit=30&token=${API_CONFIG.OPEN_MUSIC_API_TOKEN}`,
                            transform: (data) => {
                                if (data?.code === 200 && data?.data) {
                                    const list = Array.isArray(data.data)
                                        ? data.data
                                        : data.data.list || [];
                                    return {
                                        data: list.map((item) => ({
                                            id: item.rid || item.id,
                                            song: item.name,
                                            singer: item.artist,
                                            cover: item.pic,
                                            album:
                                                item.album ||
                                                item.albumName ||
                                                "",
                                            time:
                                                item.releaseDate ||
                                                item.publishTime ||
                                                item.time ||
                                                "",
                                        })),
                                    };
                                }
                                return null;
                            },
                        },
                        {
                            name: "gdstudio-kuwo-search",
                            url: `${API_CONFIG.GD_STUDIO_API}?types=search&source=kuwo&name=${encodeURIComponent(query)}&count=30&pages=${page}`,
                            transform: (data) => {
                                if (Array.isArray(data) && data.length > 0) {
                                    return {
                                        data: data.map((item) => {
                                            let coverUrl = "";
                                            if (item.pic_id) {
                                                if (
                                                    item.pic_id.startsWith(
                                                        "http",
                                                    )
                                                ) {
                                                    coverUrl = item.pic_id;
                                                } else if (
                                                    item.pic_id.includes("/")
                                                ) {
                                                    coverUrl = `https://img2.kuwo.cn/star/albumcover/500/${item.pic_id.replace(/^120\//, "")}`;
                                                } else {
                                                    coverUrl = item.pic_id
                                                        ? `/api/plugins/g-player-proxy/cover-proxy?provider=gdstudio&source=kuwo&id=${item.pic_id}&size=500`
                                                        : "";
                                                }
                                            }
                                            return {
                                                id: item.id,
                                                song: (item.name || "").trim(),
                                                singer: Array.isArray(
                                                    item.artist,
                                                )
                                                    ? item.artist
                                                          .map((a) => a.trim())
                                                          .join(", ")
                                                    : (
                                                          item.artist || ""
                                                      ).trim(),
                                                cover: coverUrl,
                                                pic_id: item.pic_id || "",
                                                lyric_id:
                                                    item.lyric_id || item.id,
                                                album: item.album || "",
                                                time: item.time || "",
                                            };
                                        }),
                                    };
                                }
                                return null;
                            },
                        },
                    ]);
                    break;
                case "joox":
                    result = await tryMultipleAPIs([
                        {
                            name: "gdstudio-joox-search",
                            url: `${API_CONFIG.GD_STUDIO_API}?types=search&source=joox&name=${encodeURIComponent(query)}&count=30&pages=${page}`,
                            transform: (data) => {
                                if (Array.isArray(data) && data.length > 0) {
                                    return {
                                        data: data.map((item) => ({
                                            id: item.id,
                                            song: item.name || "",
                                            singer: Array.isArray(item.artist)
                                                ? item.artist.join(", ")
                                                : item.artist || "",
                                            cover: item.pic_id
                                                ? `/api/plugins/g-player-proxy/cover-proxy?provider=gdstudio&source=joox&id=${encodeURIComponent(item.pic_id)}&size=500`
                                                : "",
                                            pic_id: item.pic_id || "",
                                            lyric_id: item.lyric_id || item.id,
                                            album: item.album || "",
                                            time: item.time || "",
                                        })),
                                    };
                                }
                                return null;
                            },
                        },
                    ]);
                    break;
                case "tencent":
                default:
                    result = await tryMultipleAPIs([
                        {
                            name: "vkeys-tencent-search",
                            url: `${API_CONFIG.VKEYS_TENCENT_SEARCH}?keyword=${encodeURIComponent(query)}&page=${page}&limit=30`,
                            transform: (data) => {
                                const list = data?.data?.list;
                                if (
                                    data?.code === 0 &&
                                    Array.isArray(list) &&
                                    list.length > 0
                                ) {
                                    return {
                                        data: list.map((item) => ({
                                            id: String(item.songID || ""),
                                            song: item.title || "",
                                            singer: item.singer || "",
                                            cover: item.cover || "",
                                            album: item.album || "",
                                            time: item.time || "",
                                            _mid: item.songMID || "",
                                        })),
                                    };
                                }
                                return null;
                            },
                            validate: (transformed) => {
                                return !!transformed?.data?.[0]?.id;
                            },
                        },
                        {
                            name: "qijieya-tencent-search",
                            url: `${API_CONFIG.QIJIEYA_API}?server=tencent&type=search&id=${encodeURIComponent(query)}&page=${page}&limit=30`,
                            transform: (data) => {
                                if (Array.isArray(data) && data.length > 0) {
                                    return {
                                        data: data.map((item) => {
                                            const artistRaw = item.artist;
                                            const artist = Array.isArray(
                                                artistRaw,
                                            )
                                                ? artistRaw.join(", ")
                                                : artistRaw || "";
                                            const urlStr = item.url || "";
                                            const idMatch =
                                                urlStr.match(/[?&]id=([^&]+)/);
                                            const extractedId = idMatch
                                                ? idMatch[1]
                                                : "";
                                            const songIdStr = String(
                                                item.id ||
                                                    item.url_id ||
                                                    item.mid ||
                                                    extractedId ||
                                                    "",
                                            );
                                            const rawPic =
                                                item.pic || item.cover || "";
                                            const picIdMatch =
                                                rawPic.match(/[?&]id=([^&]+)/);
                                            const coverProxyId = picIdMatch
                                                ? picIdMatch[1]
                                                : songIdStr;
                                            return {
                                                id: songIdStr,
                                                song:
                                                    item.name ||
                                                    item.title ||
                                                    "",
                                                singer: artist,
                                                cover: coverProxyId
                                                    ? `/api/plugins/g-player-proxy/cover-proxy?provider=qijieya&source=tencent&id=${encodeURIComponent(coverProxyId)}`
                                                    : "",
                                                _mid:
                                                    item.id ||
                                                    item.mid ||
                                                    extractedId ||
                                                    "",
                                            };
                                        }),
                                    };
                                }
                                return null;
                            },
                            validate: (transformed) => {
                                return !!transformed?.data?.[0]?.id;
                            },
                        },
                    ]);
                    break;
            }
            if (result) {
                res.json(result);
            } else {
                res.status(500).json({
                    error: "All search APIs failed",
                    data: [],
                });
            }
        } catch (error) {
            res.status(500).json({
                error: "Search failed",
                detail: error.message,
            });
        }
    });
    router.get("/song", async (req, res) => {
        try {
            const id = req.query.id;
            const source = req.query.source || "tencent";
            const title = req.query.title || "";
            const artist = req.query.artist || "";
            const apicxToken = readApicxToken(req);
            let excludeProviders;
            try {
                excludeProviders = new Set(
                    [
                        ...parseExcludeProviders(req.query.excludeProviders),
                    ].map(unmaskProviderName),
                );
            } catch {
                return res
                    .status(400)
                    .json({ error: "Invalid excludeProviders parameter" });
            }
            const songChainOptions = {
                detailed: true,
                emptyIsFailure: false,
                excludeProviders,
            };
            if (!id) {
                return res.status(400).json({ error: "Missing id parameter" });
            }
            let result = null;
            switch (source) {
                case "netease":
                    result = await tryMultipleAPIs([
                        {
                            name: "qijieya-netease-song",
                            url: `${API_CONFIG.QIJIEYA_API}?server=netease&type=song&id=${id}`,
                            transform: (data) => {
                                if (
                                    Array.isArray(data) &&
                                    data.length > 0 &&
                                    data[0].url &&
                                    typeof data[0].url === "string" &&
                                    data[0].url.startsWith("http")
                                ) {
                                    return {
                                        data: [
                                            {
                                                url: data[0].url,
                                                pic: data[0].pic || "",
                                                name: data[0].name || "",
                                            },
                                        ],
                                        _source: "qijieya-netease",
                                    };
                                }
                                return null;
                            },
                        },
                        {
                            name: "gdstudio-netease-song",
                            url: `${API_CONFIG.GD_STUDIO_API}?types=url&source=netease&id=${id}&br=320`,
                            transform: (data) => {
                                if (
                                    data?.url &&
                                    data.url.startsWith("http") &&
                                    !data.url.includes("版权") &&
                                    !data.url.includes("不存在")
                                ) {
                                    return {
                                        data: [{ url: data.url }],
                                        _source: "gdstudio-netease",
                                    };
                                }
                                return null;
                            },
                        },
                        {
                            name: "bugpk-netease-song",
                            url: `${API_CONFIG.BUGPK_NETEASE_SONG}?ids=${id}&level=standard&type=json`,
                            transform: (data) => {
                                if (
                                    data?.url &&
                                    data?.status === 200 &&
                                    data.url.startsWith("http")
                                ) {
                                    return {
                                        data: [
                                            {
                                                url: data.url,
                                                lyric: data.lyric,
                                                tlyric: data.tlyric,
                                                pic: data.pic,
                                                name: data.name,
                                            },
                                        ],
                                        _source: "bugpk-netease",
                                    };
                                }
                                return null;
                            },
                        },
                        {
                            name: "bugpk-aggregate-netease",
                            url: `${API_CONFIG.BUGPK_AGGREGATE}?media=netease&type=song&id=${id}`,
                            transform: (data) => {
                                if (data?.url && data.url.startsWith("http")) {
                                    return {
                                        data: [
                                            { url: data.url, lyric: data.lrc },
                                        ],
                                        _source: "bugpk-aggregate",
                                    };
                                }
                                return null;
                            },
                        },
                    ], songChainOptions);
                    break;
                case "kuwo":
                    result = await tryMultipleAPIs([
                        ...apicxKuwoSongApis({
                            token: apicxToken,
                            title,
                            artist,
                        }).map((api) => ({ ...api, timeout: 25000 })),
                        {
                            name: "openmusic-kuwo-song",
                            url: `${API_CONFIG.OPEN_MUSIC_API_URL}?provider=kw&type=song&id=${id}&format=json&level=exhigh&token=${API_CONFIG.OPEN_MUSIC_API_TOKEN}`,
                            transform: (data) => {
                                if (data?.code === 200 && data?.data?.url) {
                                    let lrcContent = "";
                                    if (
                                        typeof data.data.lrclist === "string" &&
                                        data.data.lrclist.trim() !== ""
                                    ) {
                                        lrcContent = data.data.lrclist;
                                    } else if (
                                        Array.isArray(data.data.defaultLrc)
                                    ) {
                                        lrcContent = convertLrclistToLrc(
                                            data.data.defaultLrc,
                                        );
                                    } else if (
                                        Array.isArray(data.data.lrclist)
                                    ) {
                                        lrcContent = convertLrclistToLrc(
                                            data.data.lrclist,
                                        );
                                    } else if (
                                        data.data.lyric &&
                                        typeof data.data.lyric === "string"
                                    ) {
                                        lrcContent = data.data.lyric;
                                    }
                                    return {
                                        data: {
                                            url: data.data.url,
                                            lrc: lrcContent,
                                            lrcId:
                                                data.data.lrc ||
                                                data.data.lrcId ||
                                                null,
                                        },
                                        _source: "openmusic-kw",
                                    };
                                }
                                return null;
                            },
                        },
                        {
                            name: "gdstudio-kuwo-song",
                            url: `${API_CONFIG.GD_STUDIO_API}?types=url&source=kuwo&id=${id}&br=320`,
                            transform: (data) => {
                                if (
                                    data?.url &&
                                    data.url.startsWith("http") &&
                                    !data.url.includes("版权") &&
                                    !data.url.includes("不存在")
                                ) {
                                    return {
                                        data: { url: data.url },
                                        _source: "gdstudio-kuwo",
                                    };
                                }
                                return null;
                            },
                        },
                    ], songChainOptions);
                    break;
                case "joox":
                    result = await tryMultipleAPIs([
                        {
                            name: "gdstudio-joox-song",
                            url: `${API_CONFIG.GD_STUDIO_API}?types=url&source=joox&id=${encodeURIComponent(id)}&br=320`,
                            transform: (data) => {
                                if (
                                    data?.url &&
                                    data.url.startsWith("http") &&
                                    !data.url.includes("版权") &&
                                    !data.url.includes("不存在")
                                ) {
                                    return {
                                        data: { url: data.url },
                                        _source: "gdstudio-joox",
                                    };
                                }
                                return null;
                            },
                            validate: (transformed) =>
                                validatePlayableUrl(transformed?.data?.url),
                        },
                    ], songChainOptions);
                    break;
                case "tencent":
                default:
                    result = await tryMultipleAPIs([
                        {
                            name: "vkeys-tencent-song",
                            url: `${API_CONFIG.VKEYS_TENCENT_SONG}?id=${encodeURIComponent(id)}&quality=8`,
                            transform: (data) => {
                                if (
                                    [0, 200].includes(Number(data?.code)) &&
                                    typeof data.data?.url === "string" &&
                                    data.data.url.startsWith("http")
                                ) {
                                    return {
                                        data: {
                                            url: data.data.url,
                                            lrc: "",
                                        },
                                        _source: "vkeys-tencent",
                                    };
                                }
                                return null;
                            },
                            validate: (transformed) =>
                                validatePlayableUrl(transformed?.data?.url),
                        },
                        {
                            name: "qijieya-tencent-song",
                            url: `${API_CONFIG.QIJIEYA_API}?server=tencent&type=song&id=${id}`,
                            transform: (data) => {
                                if (
                                    Array.isArray(data) &&
                                    data.length > 0 &&
                                    data[0].url &&
                                    typeof data[0].url === "string" &&
                                    data[0].url.startsWith("http") &&
                                    !data[0].url.includes(".mp4")
                                ) {
                                    return {
                                        data: {
                                            url: data[0].url,
                                            lrc: "",
                                        },
                                        _source: "qijieya-tencent",
                                    };
                                }
                                return null;
                            },
                        },
                    ], songChainOptions);

                    if (!result.result) {
                        return res.json(
                            addProviderMetadata(
                                {
                                    _needFallback: true,
                                    _reason: "all_sources_failed_or_mp4",
                                },
                                result,
                            ),
                        );
                    }
                    break;
            }
            if (result.result) {
                res.json(addProviderMetadata(result.result, result));
            } else {
                res.status(500).json(
                    addProviderMetadata(
                        { error: "All song APIs failed" },
                        result,
                    ),
                );
            }
        } catch (error) {
            res.status(500).json({
                error: "Failed to get song",
                detail: error.message,
            });
        }
    });

    router.get("/lyric", async (req, res) => {
        try {
            const id = req.query.id;
            const source = req.query.source || "tencent";
            const title = req.query.title || "";
            const artist = req.query.artist || "";
            if (!id) {
                return res.status(400).json({ error: "Missing id parameter" });
            }
            let result = null;
            switch (source) {
                case "netease":
                    try {
                        if (!isSourceEnabled("qijieya-netease-lyric")) throw new Error("Source disabled");
                        const qResp = await axios.get(
                            `${API_CONFIG.QIJIEYA_API}?server=netease&type=lrc&id=${id}`,
                            {
                                timeout: 8000,
                                responseType: "text",
                                transformResponse: [(d) => d],
                                headers: {
                                    "User-Agent":
                                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                                },
                            },
                        );
                        if (
                            typeof qResp.data === "string" &&
                            qResp.data.includes("[") &&
                            qResp.data.trim().length > 10
                        ) {
                            return res.json({
                                data: {
                                    lrc: qResp.data,
                                    tlyric: "",
                                    trans: "",
                                },
                                _source: "qijieya-netease-lyric",
                            });
                        }
                    } catch (e) {}

                    result = await tryMultipleAPIs([
                        {
                            name: "bugpk-netease-lyric",
                            url: `${API_CONFIG.BUGPK_NETEASE_SONG}?ids=${id}&level=standard&type=json`,
                            transform: (data) => {
                                if (
                                    (data?.status === 200 || data?.lyric) &&
                                    data.lyric &&
                                    data.lyric.trim() !== ""
                                ) {
                                    return {
                                        data: {
                                            lrc: data.lyric || "",
                                            tlyric: data.tlyric || "",
                                        },
                                    };
                                }
                                return null;
                            },
                        },
                        {
                            name: "gdstudio-netease-lyric",
                            url: `${API_CONFIG.GD_STUDIO_API}?types=lyric&source=netease&id=${id}`,
                            transform: (data) => {
                                if (data?.lyric && data.lyric.trim() !== "") {
                                    return {
                                        data: {
                                            lrc: data.lyric,
                                            tlyric: data.tlyric || "",
                                        },
                                    };
                                }
                                return null;
                            },
                        },
                    ]);
                    break;
                case "kuwo":
                    result = await tryMultipleAPIs([
                        {
                            name: "openmusic-kuwo-lyr",
                            url: `${API_CONFIG.OPEN_MUSIC_API_URL}?provider=kw&id=${id}&type=lyr&format=all&token=${API_CONFIG.OPEN_MUSIC_API_TOKEN}`,
                            transform: (data) => {
                                if (data?.code === 200 && data?.data) {
                                    let lrcContent = "";
                                    if (
                                        typeof data.data.lrclist === "string" &&
                                        data.data.lrclist.trim() !== ""
                                    ) {
                                        lrcContent = data.data.lrclist;
                                    } else if (
                                        Array.isArray(data.data.defaultLrc)
                                    ) {
                                        lrcContent = convertLrclistToLrc(
                                            data.data.defaultLrc,
                                        );
                                    } else if (
                                        Array.isArray(data.data.lrclist)
                                    ) {
                                        lrcContent = convertLrclistToLrc(
                                            data.data.lrclist,
                                        );
                                    } else if (data.data.lyric) {
                                        lrcContent = data.data.lyric;
                                    } else if (data.data.lrc) {
                                        lrcContent = data.data.lrc;
                                    }
                                    if (
                                        lrcContent &&
                                        lrcContent.trim() !== ""
                                    ) {
                                        return {
                                            data: { lrc: lrcContent },
                                            _source: "openmusic-kw-lyr",
                                        };
                                    }
                                }
                                return null;
                            },
                        },
                        {
                            name: "openmusic-kuwo-song-lyric-fallback",
                            url: `${API_CONFIG.OPEN_MUSIC_API_URL}?provider=kw&type=song&id=${id}&format=json&token=${API_CONFIG.OPEN_MUSIC_API_TOKEN}`,
                            transform: (data) => {
                                if (data?.code === 200 && data?.data) {
                                    let lrcContent = "";
                                    if (
                                        typeof data.data.lrclist === "string" &&
                                        data.data.lrclist.trim() !== ""
                                    ) {
                                        lrcContent = data.data.lrclist;
                                    } else if (
                                        Array.isArray(data.data.defaultLrc)
                                    ) {
                                        lrcContent = convertLrclistToLrc(
                                            data.data.defaultLrc,
                                        );
                                    } else if (
                                        Array.isArray(data.data.lrclist)
                                    ) {
                                        lrcContent = convertLrclistToLrc(
                                            data.data.lrclist,
                                        );
                                    } else if (
                                        data.data.lyric &&
                                        typeof data.data.lyric === "string"
                                    ) {
                                        lrcContent = data.data.lyric;
                                    }
                                    if (
                                        lrcContent &&
                                        lrcContent.trim() !== ""
                                    ) {
                                        return {
                                            data: { lrc: lrcContent },
                                            _source:
                                                "openmusic-kw-song-fallback",
                                        };
                                    }
                                }
                                return null;
                            },
                        },
                        {
                            name: "gdstudio-kuwo-lyric",
                            url: `${API_CONFIG.GD_STUDIO_API}?types=lyric&source=kuwo&id=${id}`,
                            transform: (data) => {
                                if (data?.lyric && data.lyric.trim() !== "") {
                                    return {
                                        data: {
                                            lrc: data.lyric,
                                            tlyric: data.tlyric || "",
                                        },
                                        _source: "gdstudio-kuwo",
                                    };
                                }
                                return null;
                            },
                        },
                        ...apicxKuwoLyricApis({
                            token: readApicxToken(req),
                            title,
                            artist,
                        }).map((api) => ({ ...api, timeout: 25000 })),
                    ]);
                    break;
                case "joox":
                    result = await tryMultipleAPIs([
                        {
                            name: "gdstudio-joox-lyric",
                            url: `${API_CONFIG.GD_STUDIO_API}?types=lyric&source=joox&id=${encodeURIComponent(id)}`,
                            transform: (data) => {
                                if (data?.lyric && data.lyric.trim() !== "") {
                                    return {
                                        data: {
                                            lrc: data.lyric,
                                            tlyric: data.tlyric || "",
                                        },
                                        _source: "gdstudio-joox",
                                    };
                                }
                                return null;
                            },
                        },
                    ]);
                    break;
                case "tencent":
                default:
                    let needCrossSource = !result;
                    if (
                        !needCrossSource &&
                        result &&
                        !result.data.tlyric &&
                        title
                    ) {
                        const lrcText = result.data.lrc || "";
                        const cleanText = lrcText
                            .replace(/\[[\d:.]+\]/g, "")
                            .replace(/\[[a-z]+:[^\]]*\]/gi, "")
                            .trim();
                        const chineseCount = (
                            cleanText.match(/[\u4e00-\u9fa5]/g) || []
                        ).length;
                        const letterCount = (cleanText.match(/[a-zA-Z]/g) || [])
                            .length;
                        const japaneseCount = (
                            cleanText.match(/[\u3040-\u309f\u30a0-\u30ff]/g) ||
                            []
                        ).length;
                        const koreanCount = (
                            cleanText.match(/[\uac00-\ud7af]/g) || []
                        ).length;
                        if (
                            letterCount > chineseCount * 2 ||
                            japaneseCount > 5 ||
                            koreanCount > 5
                        ) {
                            needCrossSource = true;
                        }
                    }

                    if (needCrossSource && title && isSourceEnabled("openmusic-kuwo-lyr")) {
                        try {
                            const query = artist ? `${title} ${artist}` : title;
                            let kwRid = null;
                            for (let page = 1; page <= 3 && !kwRid; page++) {
                                const searchResp = await axios.get(
                                    `${API_CONFIG.OPEN_MUSIC_API_URL}?provider=kw&name=${encodeURIComponent(query)}&page=${page}&limit=10&token=${API_CONFIG.OPEN_MUSIC_API_TOKEN}`,
                                    {
                                        timeout: 8000,
                                        headers: {
                                            token: API_CONFIG.OPEN_MUSIC_API_TOKEN,
                                        },
                                    },
                                );
                                if (
                                    searchResp.data?.code === 200 &&
                                    searchResp.data?.data
                                ) {
                                    const list = Array.isArray(
                                        searchResp.data.data,
                                    )
                                        ? searchResp.data.data
                                        : searchResp.data.data.list || [];
                                    if (list.length === 0) break;
                                    const lowerTitle = title
                                        .toLowerCase()
                                        .trim();
                                    const lowerArtist = (artist || "")
                                        .toLowerCase()
                                        .trim();
                                    const matched = list.find((item) => {
                                        const iTitle = (item.name || "")
                                            .toLowerCase()
                                            .trim();
                                        const iArtistRaw = item.artist;
                                        const iArtist = Array.isArray(
                                            iArtistRaw,
                                        )
                                            ? iArtistRaw
                                                  .map((a) =>
                                                      typeof a === "string"
                                                          ? a
                                                          : a.name || "",
                                                  )
                                                  .join(",")
                                                  .toLowerCase()
                                            : (iArtistRaw || "").toLowerCase();
                                        const titleHit =
                                            iTitle === lowerTitle ||
                                            iTitle.includes(lowerTitle) ||
                                            lowerTitle.includes(iTitle);
                                        const artistHit =
                                            !lowerArtist ||
                                            iArtist.includes(lowerArtist) ||
                                            lowerArtist
                                                .split(/[\/&,]/)
                                                .some((a) =>
                                                    iArtist.includes(a.trim()),
                                                );
                                        return titleHit && artistHit;
                                    });
                                    if (matched)
                                        kwRid = matched.rid || matched.id;
                                    if (list.length < 10) break;
                                } else break;
                            }

                            if (kwRid) {
                                const lyrResp = await axios.get(
                                    `${API_CONFIG.OPEN_MUSIC_API_URL}?provider=kw&id=${kwRid}&type=lyr&format=all&token=${API_CONFIG.OPEN_MUSIC_API_TOKEN}`,
                                    {
                                        timeout: 8000,
                                        headers: {
                                            token: API_CONFIG.OPEN_MUSIC_API_TOKEN,
                                        },
                                    },
                                );
                                if (
                                    lyrResp.data?.code === 200 &&
                                    lyrResp.data?.data
                                ) {
                                    let kwLrc = "";
                                    const kwData = lyrResp.data.data;
                                    if (
                                        kwData.lrclist &&
                                        typeof kwData.lrclist === "string"
                                    ) {
                                        kwLrc = kwData.lrclist;
                                    } else if (
                                        kwData.defaultLrc &&
                                        Array.isArray(kwData.defaultLrc)
                                    ) {
                                        kwLrc = convertLrclistToLrc(
                                            kwData.defaultLrc,
                                        );
                                    } else if (kwData.lyric) {
                                        kwLrc = kwData.lyric;
                                    }
                                    if (kwLrc && kwLrc.trim() !== "") {
                                        result = {
                                            data: {
                                                lrc: kwLrc,
                                                tlyric: "",
                                                trans: "",
                                            },
                                            _source: "kuwo-cross-source",
                                        };
                                    }
                                }
                            }
                        } catch (e) {
                            console.warn(
                                "[API] kuwo 跨源补歌词失败:",
                                e.message,
                            );
                        }
                    }

                    if (!result && isSourceEnabled("qijieya-tencent-lyric")) {
                        try {
                            const qResp = await axios.get(
                                `${API_CONFIG.QIJIEYA_API}?server=tencent&type=lrc&id=${id}`,
                                {
                                    timeout: 8000,
                                    responseType: "text",
                                    transformResponse: [(d) => d],
                                    headers: {
                                        "User-Agent":
                                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                                    },
                                },
                            );
                            if (
                                typeof qResp.data === "string" &&
                                qResp.data.includes("[") &&
                                qResp.data.trim().length > 10
                            ) {
                                result = {
                                    data: {
                                        lrc: qResp.data,
                                        tlyric: "",
                                        trans: "",
                                    },
                                    _source: "qijieya-tencent-lyric",
                                };
                            }
                        } catch (e) {}
                    }
                    break;
            }
            if (!result && title && isSourceEnabled("gdstudio-kw-by-name")) {
                const query = artist ? `${title} ${artist}` : title;
                try {
                    const searchRes = await axios.get(
                        `${API_CONFIG.GD_STUDIO_API}?types=search&source=kuwo&name=${encodeURIComponent(query)}&count=1&pages=1`,
                        { timeout: 10000 },
                    );
                    if (
                        Array.isArray(searchRes.data) &&
                        searchRes.data.length > 0
                    ) {
                        const songId = searchRes.data[0].id;
                        const lyrRes = await axios.get(
                            `${API_CONFIG.GD_STUDIO_API}?types=lyric&source=kuwo&id=${songId}`,
                            { timeout: 10000 },
                        );
                        if (
                            lyrRes.data?.lyric &&
                            lyrRes.data.lyric.trim() !== ""
                        ) {
                            result = {
                                data: {
                                    lrc: lyrRes.data.lyric,
                                    tlyric: lyrRes.data.tlyric || "",
                                },
                                _source: "gdstudio-kw-by-name",
                            };
                        }
                    }
                } catch (fallbackErr) {}
            }
            if (result) {
                res.json(result);
            } else {
                res.json({ data: { lrc: "", tlyric: "", trans: "" } });
            }
        } catch (error) {
            res.json({ data: { lrc: "", tlyric: "", trans: "" } });
        }
    });

    router.get("/stream", async (req, res) => {
        try {
            const musicUrl = req.query.url;
            if (!musicUrl || !musicUrl.startsWith("http")) {
                return res.status(400).send("Invalid url parameter");
            }
            let referer = "https://www.google.com/";
            if (musicUrl.includes("qqmusic.qq.com")) {
                referer = "https://y.qq.com/";
            } else if (musicUrl.includes("music.126.net")) {
                referer = "https://music.163.com/";
            } else if (musicUrl.includes("kuwo.cn")) {
                referer = "https://www.kuwo.cn/";
            }
            const requestHeaders = {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                Referer: referer,
            };
            if (req.headers.range) {
                requestHeaders.Range = req.headers.range;
            }
            const response = await axios({
                method: "get",
                url: musicUrl,
                responseType: "stream",
                headers: requestHeaders,
                timeout: 30000,
                validateStatus: (status) =>
                    (status >= 200 && status < 300) || status === 206,
            });
            const upstreamContentType = response.headers["content-type"];
            let finalContentType;
            if (
                upstreamContentType &&
                upstreamContentType.startsWith("audio/")
            ) {
                finalContentType = upstreamContentType;
            } else {
                finalContentType = getAudioMimeType(musicUrl);
            }
            res.setHeader("Content-Type", finalContentType);
            if (response.headers["content-length"]) {
                res.setHeader(
                    "Content-Length",
                    response.headers["content-length"],
                );
            }
            if (response.headers["content-range"]) {
                res.setHeader(
                    "Content-Range",
                    response.headers["content-range"],
                );
            }
            res.setHeader("Accept-Ranges", "bytes");
            if (req.headers.range && response.status === 206) {
                res.status(206);
            }
            let streamFinished = false;
            const destroyUpstream = () => {
                if (!streamFinished && !response.data.destroyed) {
                    response.data.destroy();
                }
            };
            req.on("aborted", destroyUpstream);
            res.on("close", destroyUpstream);
            response.data.on("end", () => {
                streamFinished = true;
            });
            response.data.on("error", (streamError) => {
                if (res.destroyed || res.writableEnded) return;
                console.warn("[Stream Proxy] Upstream stream failed:", streamError.message);
                res.destroy(streamError);
            });
            response.data.pipe(res);
        } catch (error) {
            if (res.headersSent) {
                if (!res.destroyed) res.destroy(error);
                return;
            }
            res.status(502).send("Stream failed");
        }
    });

    router.get("/font-proxy", async (req, res) => {
        try {
            const fontUrl = req.query.url;
            if (!fontUrl || !fontUrl.startsWith("http")) {
                return res.status(400).send("Invalid url parameter");
            }

            const response = await axios({
                method: "get",
                url: fontUrl,
                responseType: "stream",
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                },
                timeout: 30000,
            });
            const lowerUrl = fontUrl.toLowerCase();
            let contentType = "font/woff2";
            if (lowerUrl.includes(".woff2")) contentType = "font/woff2";
            else if (lowerUrl.includes(".woff")) contentType = "font/woff";
            else if (lowerUrl.includes(".ttf")) contentType = "font/ttf";
            else if (lowerUrl.includes(".otf")) contentType = "font/otf";
            else if (lowerUrl.includes(".eot"))
                contentType = "application/vnd.ms-fontobject";

            res.setHeader("Content-Type", contentType);
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Cache-Control", "public, max-age=604800"); // 缓存7天

            if (response.headers["content-length"]) {
                res.setHeader(
                    "Content-Length",
                    response.headers["content-length"],
                );
            }

            response.data.pipe(res);
        } catch (error) {
            console.error("[Font Proxy] Failed:", error.message);
            res.status(502).send("Font proxy failed");
        }
    });
    router.get("/cover-proxy", async (req, res) => {
        try {
            const provider = req.query.provider;
            const source = req.query.source;
            const id = req.query.id;
            const size = req.query.size || "500";

            if (!provider || !id) {
                return res.status(400).send("Missing required params");
            }

            let realUrl = null;

            const directUrl = req.query.url;
            if (directUrl && /^https?:\/\//i.test(directUrl)) {
                realUrl = directUrl;
            } else if (provider === "gdstudio") {
                if (!isSourceEnabled("gdstudio-cover")) return res.status(503).send("Source disabled");
                if (!source) return res.status(400).send("Missing source");
                const apiUrl = `${API_CONFIG.GD_STUDIO_API}?types=pic&source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}&size=${encodeURIComponent(size)}`;
                try {
                    const resp = await axios.get(apiUrl, {
                        timeout: 10000,
                        headers: {
                            "User-Agent":
                                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                        },
                    });
                    if (
                        resp.data?.url &&
                        typeof resp.data.url === "string" &&
                        resp.data.url.startsWith("http")
                    ) {
                        realUrl = resp.data.url;
                    }
                } catch (e) {
                    console.warn("[Cover Proxy] gdstudio 解析失败:", e.message);
                }
            } else if (provider === "qijieya") {
                if (!source) return res.status(400).send("Missing source");
                if (source === "netease" || source === "tencent") {
                    realUrl = `${API_CONFIG.QIJIEYA_API}?server=${encodeURIComponent(source)}&type=pic&id=${encodeURIComponent(id)}`;
                } else {
                    if (!isSourceEnabled("gdstudio-cover")) return res.status(503).send("Source disabled");
                    const apiUrl = `${API_CONFIG.GD_STUDIO_API}?types=pic&source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}&size=${encodeURIComponent(size)}`;
                    try {
                        const resp = await axios.get(apiUrl, {
                            timeout: 10000,
                            headers: {
                                "User-Agent":
                                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                            },
                        });
                        if (
                            resp.data?.url &&
                            typeof resp.data.url === "string" &&
                            resp.data.url.startsWith("http")
                        ) {
                            realUrl = resp.data.url;
                        }
                    } catch (e) {
                        console.warn(
                            "[Cover Proxy] gdstudio 降级解析失败:",
                            e.message,
                        );
                    }
                }
            }

            if (!realUrl) {
                res.setHeader("Cache-Control", "no-store");
                return res.status(404).send("Cover not found");
            }

            let referer = "";
            if (realUrl.includes("music.126.net")) {
                referer = "https://music.163.com/";
            } else if (
                realUrl.includes("qqmusic.qq.com") ||
                realUrl.includes("y.gtimg.cn") ||
                realUrl.includes("y.qq.com")
            ) {
                referer = "https://y.qq.com/";
            } else if (realUrl.includes("kuwo")) {
                referer = "https://www.kuwo.cn/";
            }

            const imgHeaders = {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            };
            if (referer) imgHeaders.Referer = referer;

            try {
                const imgResp = await axios({
                    method: "get",
                    url: realUrl,
                    responseType: "stream",
                    timeout: 15000,
                    maxRedirects: 5,
                    headers: imgHeaders,
                    validateStatus: (s) => s >= 200 && s < 300,
                });

                const upstreamType = imgResp.headers["content-type"] || "";
                if (!upstreamType.startsWith("image/")) {
                    res.setHeader("Cache-Control", "no-store");
                    return res.status(404).send("Not an image");
                }

                res.setHeader("Content-Type", upstreamType);
                res.setHeader("Cache-Control", "public, max-age=86400");
                if (imgResp.headers["content-length"]) {
                    res.setHeader(
                        "Content-Length",
                        imgResp.headers["content-length"],
                    );
                }
                imgResp.data.pipe(res);
            } catch (e) {
                console.warn("[Cover Proxy] 拉取图片失败:", e.message);
                res.setHeader("Cache-Control", "no-store");
                return res.status(404).send("Cover fetch failed");
            }
        } catch (error) {
            console.error("[Cover Proxy] Failed:", error.message);
            res.setHeader("Cache-Control", "no-store");
            return res.status(404).send("Cover proxy failed");
        }
    });
    router.get("/playlists", (req, res) => {
        const data = loadPlaylists();
        const list = data.playlists.map((p) => ({
            id: p.id,
            name: p.name,
            cover: p.cover || "",
            source: p.source || "custom",
            sourceId: p.sourceId || "",
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            songCount: Array.isArray(p.songs) ? p.songs.length : 0,
        }));
        res.json({ playlists: list });
    });

    router.get("/playlists/:id", (req, res) => {
        const data = loadPlaylists();
        const playlist = data.playlists.find((p) => p.id === req.params.id);
        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }
        res.json(playlist);
    });

    router.post("/playlists", (req, res) => {
        const { name, cover } = req.body || {};
        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: "Name is required" });
        }
        const data = loadPlaylists();
        const now = new Date().toISOString();
        const playlist = {
            id: genPlaylistId(),
            name: String(name).trim(),
            cover: cover || "",
            source: "custom",
            createdAt: now,
            updatedAt: now,
            songs: [],
        };
        data.playlists.push(playlist);
        if (!savePlaylists(data)) {
            return res.status(500).json({ error: "Failed to save" });
        }
        res.json(playlist);
    });

    router.put("/playlists/:id", (req, res) => {
        const { name, cover } = req.body || {};
        const data = loadPlaylists();
        const playlist = data.playlists.find((p) => p.id === req.params.id);
        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }
        if (name && String(name).trim()) playlist.name = String(name).trim();
        if (cover !== undefined) playlist.cover = cover;
        playlist.updatedAt = new Date().toISOString();
        if (!savePlaylists(data)) {
            return res.status(500).json({ error: "Failed to save" });
        }
        res.json(playlist);
    });

    router.delete("/playlists/:id", (req, res) => {
        const data = loadPlaylists();
        const idx = data.playlists.findIndex((p) => p.id === req.params.id);
        if (idx === -1) {
            return res.status(404).json({ error: "Playlist not found" });
        }
        const removed = data.playlists.splice(idx, 1)[0];
        if (!savePlaylists(data)) {
            return res.status(500).json({ error: "Failed to save" });
        }
        res.json({ success: true, removed });
    });

    router.post("/playlists/:id/songs", (req, res) => {
        const { songs } = req.body || {};
        if (!Array.isArray(songs)) {
            return res.status(400).json({ error: "songs must be an array" });
        }
        const data = loadPlaylists();
        const playlist = data.playlists.find((p) => p.id === req.params.id);
        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }
        if (!Array.isArray(playlist.songs)) playlist.songs = [];

        const existing = new Set(playlist.songs.map(songKey));
        let added = 0;
        songs.forEach((s) => {
            if (!s || !s.title) return;
            const k = songKey(s);
            if (!existing.has(k)) {
                playlist.songs.push({
                    title: String(s.title).trim(),
                    artist: String(s.artist || "").trim(),
                    cover: s.cover || "",
                });
                existing.add(k);
                added++;
            }
        });
        playlist.updatedAt = new Date().toISOString();
        if (!savePlaylists(data)) {
            return res.status(500).json({ error: "Failed to save" });
        }
        res.json({ success: true, added, total: playlist.songs.length });
    });

    router.delete("/playlists/:id/songs", (req, res) => {
        const { indices, songs: songsToRemove } = req.body || {};
        const data = loadPlaylists();
        const playlist = data.playlists.find((p) => p.id === req.params.id);
        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }
        if (!Array.isArray(playlist.songs)) playlist.songs = [];

        let removed = 0;
        if (Array.isArray(indices) && indices.length > 0) {
            const sortedIdx = [...indices]
                .filter((i) => Number.isInteger(i))
                .sort((a, b) => b - a);
            sortedIdx.forEach((i) => {
                if (i >= 0 && i < playlist.songs.length) {
                    playlist.songs.splice(i, 1);
                    removed++;
                }
            });
        } else if (Array.isArray(songsToRemove) && songsToRemove.length > 0) {
            const keys = new Set(songsToRemove.map(songKey));
            const before = playlist.songs.length;
            playlist.songs = playlist.songs.filter(
                (s) => !keys.has(songKey(s)),
            );
            removed = before - playlist.songs.length;
        }
        playlist.updatedAt = new Date().toISOString();
        if (!savePlaylists(data)) {
            return res.status(500).json({ error: "Failed to save" });
        }
        res.json({ success: true, removed, total: playlist.songs.length });
    });

    router.post("/playlists/parse-url", async (req, res) => {
        const { url } = req.body || {};
        if (!url) {
            return res.status(400).json({ error: "URL is required" });
        }
        const parsed = await resolvePlaylistUrl(url);
        if (!parsed) {
            return res.status(400).json({
                error: "无法识别此链接，请粘贴网易云音乐或 QQ 音乐的歌单分享链接",
            });
        }
        res.json(parsed);
    });

    router.post("/playlists/import", async (req, res) => {
        const { url, name: customName } = req.body || {};
        if (!url) {
            return res.status(400).json({ error: "URL is required" });
        }

        const parsed = await resolvePlaylistUrl(url);
        if (!parsed) {
            return res.status(400).json({
                error: "无法识别此链接，请确认是网易云音乐或 QQ 音乐的歌单链接",
            });
        }

        const songs = await importPlaylistFromApi(parsed.server, parsed.id);
        if (!songs || songs.length === 0) {
            return res.status(502).json({
                error: "获取歌单内容失败，可能是歌单不存在或接口暂时不可用",
            });
        }

        const data = loadPlaylists();
        const now = new Date().toISOString();
        const defaultName =
            parsed.server === "netease"
                ? `网易云歌单 · ${parsed.id}`
                : `QQ音乐歌单 · ${parsed.id}`;
        const playlist = {
            id: genPlaylistId(),
            name: (customName && String(customName).trim()) || defaultName,
            cover: songs[0]?.cover || "",
            source: parsed.server,
            sourceId: parsed.id,
            createdAt: now,
            updatedAt: now,
            songs: songs,
        };
        data.playlists.push(playlist);

        if (!savePlaylists(data)) {
            return res.status(500).json({ error: "保存失败" });
        }
        res.json({
            success: true,
            playlist: {
                id: playlist.id,
                name: playlist.name,
                cover: playlist.cover,
                source: playlist.source,
                sourceId: playlist.sourceId,
                createdAt: playlist.createdAt,
                updatedAt: playlist.updatedAt,
                songCount: songs.length,
            },
        });
    });
    router.post("/playlists/:id/refresh", async (req, res) => {
        const data = loadPlaylists();
        const playlist = data.playlists.find((p) => p.id === req.params.id);
        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        const server = playlist.source;
        const sourceId = playlist.sourceId;
        if (!server || server === "custom" || !sourceId) {
            return res.status(400).json({
                error: "该歌单不是从链接导入的，无法从来源更新",
            });
        }

        const remoteSongs = await importPlaylistFromApi(server, sourceId);
        if (!remoteSongs || remoteSongs.length === 0) {
            return res.status(502).json({
                error: "获取来源歌单失败，可能是歌单已被删除或接口暂时不可用",
            });
        }

        if (!Array.isArray(playlist.songs)) playlist.songs = [];

        const isFirstRefresh = !Array.isArray(playlist.sourceSongKeys);
        const prevSourceKeys = isFirstRefresh
            ? new Set()
            : new Set(playlist.sourceSongKeys);

        const localMap = new Map();
        playlist.songs.forEach((s) => {
            const k = songKey(s);
            if (!localMap.has(k)) localMap.set(k, s);
        });

        const remoteKeys = new Set(remoteSongs.map(songKey));

        const manualSongs = [];
        let removed = 0;
        localMap.forEach((song, k) => {
            if (remoteKeys.has(k)) return;
            if (isFirstRefresh || !prevSourceKeys.has(k)) {
                manualSongs.push(song);
            } else {
                removed++;
            }
        });

        let added = 0;
        const merged = remoteSongs.map((s) => {
            const k = songKey(s);
            const existing = localMap.get(k);
            if (!existing) added++;
            return {
                title: String(s.title).trim(),
                artist: String(s.artist || "").trim(),
                cover: s.cover || existing?.cover || "",
            };
        });

        playlist.songs = merged.concat(manualSongs);
        playlist.sourceSongKeys = Array.from(remoteKeys);
        playlist.cover = merged[0]?.cover || playlist.cover || "";
        playlist.updatedAt = new Date().toISOString();

        if (!savePlaylists(data)) {
            return res.status(500).json({ error: "保存失败" });
        }

        res.json({
            success: true,
            added,
            removed,
            kept: manualSongs.length,
            total: playlist.songs.length,
            firstRefresh: isFirstRefresh,
        });
    });

    registerDiagnoseRoutes(router, API_CONFIG);
    console.log("[G-Player Proxy] ✓ 歌单模块已加载");
    console.log("[G-Player Proxy] ✓ 已启动");
}
