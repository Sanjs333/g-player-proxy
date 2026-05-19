import axios from "axios";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const info = {
  id: "g-player-proxy",
  name: "G-Player Music Proxy",
  description: "为 G-Player 音乐播放器提供多音源代理支持。",
};

const API_CONFIG = {
  VKEYS_NETEASE_SEARCH: "https://api.vkeys.cn/v2/music/netease?word=",
  VKEYS_TENCENT_SEARCH: "https://api.vkeys.cn/v2/music/tencent?word=",
  VKEYS_TENCENT_SONG: "https://api.vkeys.cn/music/tencent/song/link",
  VKEYS_TENCENT_LYRIC: "https://api.vkeys.cn/v2/music/tencent/lyric?id=",
  BUGPK_NETEASE_SONG: "https://api.bugpk.com/api/163_music",
  BUGPK_AGGREGATE: "https://api.bugpk.com/api/music",
  OPEN_MUSIC_API_URL: "https://open-music-server.pages.dev/api/music",
  OPEN_MUSIC_API_TOKEN:
    "ark-6VY6nBX2QgL3HEu9yFR5-zhrFHMLfhr-9LVk2Y5ecAH3ALAMHnrObY-KMXIMqN_WMniBlkluIPsyVfu22rhRZyRjQXng4ecBrzrwaurGKrHdVXJGOlt5RxnOnho1BFTQ",
  GD_STUDIO_API: "https://music-api.gdstudio.xyz/api.php",
  QIJIEYA_API: "https://api.qijieya.cn/meting/",
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLAYLIST_FILE = path.join(__dirname, "playlists.json");

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
    console.log("[Playlists] 检测到短链，尝试解析:", url);
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
      console.log("[Playlists] 短链跳转后的最终URL:", finalUrl || "(未能获取)");
      if (finalUrl) {
        url = finalUrl;
      } else if (typeof resp.data === "string") {
        const htmlId =
          resp.data.match(/playlist[\/=](\d{6,})/i) ||
          resp.data.match(/dissid[^0-9]*(\d{6,})/i) ||
          resp.data.match(/"id"\s*:\s*"?(\d{8,})"?/);
        if (htmlId) {
          console.log("[Playlists] 从HTML内容中提取到歌单ID:", htmlId[1]);
          return { server: "tencent", id: htmlId[1] };
        }
      }
    } catch (e) {
      console.warn("[Playlists] 短链解析失败:", e.message);
    }
  }

  console.log("[Playlists] 最终用于正则匹配的URL:", url);

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

    const trackIds = (playlist.trackIds || []).map((t) => t.id).filter(Boolean);

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

    console.log(
      `[Playlists] 网易云歌单共 ${trackIds.length} 首歌，开始分批获取详情...`,
    );

    const BATCH_SIZE = 400;
    const allSongs = [];
    const totalBatches = Math.ceil(trackIds.length / BATCH_SIZE);

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

        console.log(
          `[Playlists] 批次 ${Math.floor(i / BATCH_SIZE) + 1}/${totalBatches} 完成，累计 ${allSongs.length} 首`,
        );
      } catch (e) {
        console.warn(
          `[Playlists] 批次 ${Math.floor(i / BATCH_SIZE) + 1} 获取失败:`,
          e.message,
        );
      }
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
      console.log(`[Playlists] ✓ 网易云直连API导入 ${songs.length} 首歌`);
      return songs;
    }
    console.log("[Playlists] 网易云直连失败，降级使用 meting API");
  }

  const apis = [
    `https://api.qijieya.cn/meting/?server=${server}&type=playlist&id=${id}`,
    `https://api.injahow.cn/meting/?server=${server}&type=playlist&id=${id}`,
  ];

  for (const url of apis) {
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
        console.log(`[Playlists] ✓ 从 ${url} 导入 ${songs.length} 首歌`);
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

async function tryMultipleAPIs(apis) {
  for (const api of apis) {
    try {
      const response = await axios.get(api.url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          token: API_CONFIG.OPEN_MUSIC_API_TOKEN,
        },
        timeout: 15000,
      });
      const transformed = api.transform
        ? api.transform(response.data)
        : response.data;
      if (transformed === null) continue;
      if (api.validate && !api.validate(transformed)) continue;
      const hasData =
        transformed?.data &&
        (Array.isArray(transformed.data) ? transformed.data.length > 0 : true);
      if (hasData) return transformed;
    } catch (error) {}
  }
  return null;
}

export async function init(router) {
  router.use(express.json({ limit: "10mb" }));
  router.get("/search", async (req, res) => {
    try {
      const query = req.query.query;
      const source = req.query.source || "tencent";
      const page = Math.max(1, parseInt(req.query.page) || 1);
      if (!query) {
        return res.status(400).json({ error: "Missing query parameter" });
      }
      let result = null;
      switch (source) {
        case "netease":
          result = await tryMultipleAPIs([
            {
              name: "vkeys-netease-search",
              url: `${API_CONFIG.VKEYS_NETEASE_SEARCH}${encodeURIComponent(query)}&page=${page}&num=30`,
              transform: (data) => data,
            },
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
                        ? `${API_CONFIG.GD_STUDIO_API}?types=pic&source=netease&id=${item.pic_id}&size=500`
                        : "",
                      pic_id: item.pic_id || "",
                      lyric_id: item.lyric_id || item.id,
                    })),
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
                        if (item.pic_id.startsWith("http")) {
                          coverUrl = item.pic_id;
                        } else if (item.pic_id.includes("/")) {
                          coverUrl = `https://img2.kuwo.cn/star/albumcover/500/${item.pic_id.replace(/^120\//, "")}`;
                        } else {
                          coverUrl = `${API_CONFIG.GD_STUDIO_API}?types=pic&source=kuwo&id=${item.pic_id}&size=500`;
                        }
                      }
                      return {
                        id: item.id,
                        song: (item.name || "").trim(),
                        singer: Array.isArray(item.artist)
                          ? item.artist.map((a) => a.trim()).join(", ")
                          : (item.artist || "").trim(),
                        cover: coverUrl,
                        pic_id: item.pic_id || "",
                        lyric_id: item.lyric_id || item.id,
                      };
                    }),
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
              url: `${API_CONFIG.VKEYS_TENCENT_SEARCH}${encodeURIComponent(query)}&page=${page}&num=30`,
              transform: (data) => {
                if (data?.data && Array.isArray(data.data)) {
                  return {
                    ...data,
                    data: data.data.map((item) => ({
                      ...item,
                      id: item.mid || item.songmid || item.id,
                      _originalId: item.id,
                      _mid: item.mid || item.songmid || "",
                    })),
                  };
                }
                return data;
              },
            },
            {
              name: "bugpk-tencent-search",
              url: `${API_CONFIG.BUGPK_AGGREGATE}?media=tencent&type=search&word=${encodeURIComponent(query)}`,
              transform: (data) => (page > 1 ? null : data),
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
                    data: [{ url: data.url, lyric: data.lrc }],
                    _source: "bugpk-aggregate",
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
              name: "openmusic-kuwo-song",
              url: `${API_CONFIG.OPEN_MUSIC_API_URL}?provider=kw&type=song&id=${id}&format=json&level=exhigh&token=${API_CONFIG.OPEN_MUSIC_API_TOKEN}`,
              transform: (data) => {
                if (data?.code === 200 && data?.data?.url) {
                  let lrcContent = "";
                  if (data.data.lyric && typeof data.data.lyric === "string") {
                    lrcContent = data.data.lyric;
                  } else if (
                    data.data.lrclist &&
                    Array.isArray(data.data.lrclist)
                  ) {
                    lrcContent = convertLrclistToLrc(data.data.lrclist);
                  }
                  return {
                    data: {
                      url: data.data.url,
                      lrc: lrcContent,
                      lrcId: data.data.lrc || data.data.lrcId || null,
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
          ]);
          break;
        case "tencent":
        default:
          const qualityLevels = [10, 6, 4];
          const isNumericId = /^\d+$/.test(String(id));
          const paramName = isNumericId ? "id" : "mid";

          for (const quality of qualityLevels) {
            try {
              const requestUrl = `${API_CONFIG.VKEYS_TENCENT_SONG}?${paramName}=${id}&quality=${quality}`;
              const response = await axios.get(requestUrl, {
                headers: {
                  "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                },
                timeout: 5000,
              });

              const data = response.data;
              const url = data?.data?.url;
              const kbps = data?.data?.kbps;
              const isSuccess = data?.code === 200 || data?.code === 0;
              const urlPath = url ? url.replace(/^https?:\/\/[^/]+/, "") : "";
              const hasRealPath =
                urlPath.length > 1 &&
                (urlPath.includes(".") ||
                  urlPath.includes("vkey=") ||
                  urlPath.includes("?"));
              const isValidKbps =
                kbps &&
                String(kbps) !== "0kbps" &&
                String(kbps) !== "0" &&
                kbps !== 0;

              if (
                isSuccess &&
                url &&
                url.startsWith("http") &&
                !url.includes(".mp4") &&
                hasRealPath &&
                isValidKbps
              ) {
                result = {
                  data: {
                    url: url,
                    lrc: "",
                  },
                  _source: `vkeys-tencent-q${quality}`,
                  _quality: data.data.quality || `q${quality}`,
                  _kbps: data.data.kbps || "",
                };
                break;
              }
            } catch (error) {}
          }

          if (!result) {
            result = await tryMultipleAPIs([
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
            ]);
          }

          if (!result) {
            return res.json({
              _needFallback: true,
              _reason: "all_sources_failed_or_mp4",
            });
          }
          break;
      }
      if (result) {
        res.json(result);
      } else {
        res.status(500).json({ error: "All song APIs failed" });
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
            const qResp = await axios.get(
              `${API_CONFIG.QIJIEYA_API}?server=netease&type=lyric&id=${id}`,
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
                  if (data.data.lrclist && Array.isArray(data.data.lrclist)) {
                    lrcContent = convertLrclistToLrc(data.data.lrclist);
                  } else if (data.data.lyric) {
                    lrcContent = data.data.lyric;
                  } else if (data.data.lrc) {
                    lrcContent = data.data.lrc;
                  }
                  if (lrcContent && lrcContent.trim() !== "") {
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
                  if (data.data.lyric && typeof data.data.lyric === "string") {
                    lrcContent = data.data.lyric;
                  } else if (
                    data.data.lrclist &&
                    Array.isArray(data.data.lrclist)
                  ) {
                    lrcContent = convertLrclistToLrc(data.data.lrclist);
                  }
                  if (lrcContent && lrcContent.trim() !== "") {
                    return {
                      data: { lrc: lrcContent },
                      _source: "openmusic-kw-song-fallback",
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
          ]);
          break;
        case "tencent":
        default:
          let lyricId = id;
          const isNumericLyricId = /^\d+$/.test(String(id));

          if (!isNumericLyricId && title) {
            try {
              const query = artist ? `${title} ${artist}` : title;
              const searchRes = await axios.get(
                `${API_CONFIG.VKEYS_TENCENT_SEARCH}${encodeURIComponent(query)}`,
                {
                  headers: {
                    "User-Agent":
                      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                  },
                  timeout: 10000,
                },
              );

              if (searchRes.data?.data && Array.isArray(searchRes.data.data)) {
                const matched = searchRes.data.data.find(
                  (item) => item.mid === id || item.songmid === id,
                );
                if (matched && matched.id) {
                  lyricId = matched.id;
                } else if (searchRes.data.data[0]?.id) {
                  lyricId = searchRes.data.data[0].id;
                }
              }
            } catch (e) {
              console.debug(`[lyric] mid 反查失败，继续用原 id`);
            }
          }

          result = await tryMultipleAPIs([
            {
              name: "vkeys-tencent-lyric",
              url: `${API_CONFIG.VKEYS_TENCENT_LYRIC}${lyricId}`,
              transform: (data) => {
                if (data?.data?.lrc && data.data.lrc.trim() !== "") {
                  return {
                    data: {
                      lrc: data.data.lrc || "",
                      tlyric: data.data.trans || "",
                      trans: data.data.trans || "",
                    },
                  };
                }
                return null;
              },
            },
          ]);
          break;
      }
      if (!result && title) {
        const query = artist ? `${title} ${artist}` : title;
        try {
          const searchRes = await axios.get(
            `${API_CONFIG.GD_STUDIO_API}?types=search&source=kuwo&name=${encodeURIComponent(query)}&count=1&pages=1`,
            { timeout: 10000 },
          );
          if (Array.isArray(searchRes.data) && searchRes.data.length > 0) {
            const songId = searchRes.data[0].id;
            const lyrRes = await axios.get(
              `${API_CONFIG.GD_STUDIO_API}?types=lyric&source=kuwo&id=${songId}`,
              { timeout: 10000 },
            );
            if (lyrRes.data?.lyric && lyrRes.data.lyric.trim() !== "") {
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
      if (upstreamContentType && upstreamContentType.startsWith("audio/")) {
        finalContentType = upstreamContentType;
      } else {
        finalContentType = getAudioMimeType(musicUrl);
      }
      res.setHeader("Content-Type", finalContentType);
      if (response.headers["content-length"]) {
        res.setHeader("Content-Length", response.headers["content-length"]);
      }
      if (response.headers["content-range"]) {
        res.setHeader("Content-Range", response.headers["content-range"]);
      }
      res.setHeader("Accept-Ranges", "bytes");
      if (req.headers.range && response.status === 206) {
        res.status(206);
      }
      response.data.pipe(res);
    } catch (error) {
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
        res.setHeader("Content-Length", response.headers["content-length"]);
      }

      response.data.pipe(res);
    } catch (error) {
      console.error("[Font Proxy] Failed:", error.message);
      res.status(502).send("Font proxy failed");
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
      playlist.songs = playlist.songs.filter((s) => !keys.has(songKey(s)));
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

  console.log("[G-Player Proxy] ✓ 歌单模块已加载");
  console.log("[G-Player Proxy] ✓ 已启动");
}
