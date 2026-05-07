import axios from "axios";

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
};

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
  router.get("/search", async (req, res) => {
    try {
      const query = req.query.query;
      const source = req.query.source || "tencent";
      if (!query) {
        return res.status(400).json({ error: "Missing query parameter" });
      }
      let result = null;
      switch (source) {
        case "netease":
          result = await tryMultipleAPIs([
            {
              name: "vkeys-netease-search",
              url: `${API_CONFIG.VKEYS_NETEASE_SEARCH}${encodeURIComponent(query)}`,
              transform: (data) => data,
            },
            {
              name: "gdstudio-netease-search",
              url: `${API_CONFIG.GD_STUDIO_API}?types=search&source=netease&name=${encodeURIComponent(query)}&count=30&pages=1`,
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
              url: `${API_CONFIG.OPEN_MUSIC_API_URL}?provider=kw&name=${encodeURIComponent(query)}&page=1&limit=30&token=${API_CONFIG.OPEN_MUSIC_API_TOKEN}`,
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
              url: `${API_CONFIG.GD_STUDIO_API}?types=search&source=kuwo&name=${encodeURIComponent(query)}&count=30&pages=1`,
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
              url: `${API_CONFIG.VKEYS_TENCENT_SEARCH}${encodeURIComponent(query)}`,
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
              transform: (data) => data,
            },
            {
              name: "gdstudio-tencent-search",
              url: `${API_CONFIG.GD_STUDIO_API}?types=search&source=tencent&name=${encodeURIComponent(query)}&count=30&pages=1`,
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
                        ? `${API_CONFIG.GD_STUDIO_API}?types=pic&source=tencent&id=${item.pic_id}&size=500`
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
          const qualityLevels = [10, 8, 7, 6, 5, 4];
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
                timeout: 15000,
              });

              const data = response.data;
              const url = data?.data?.url;
              const isSuccess = data?.code === 200 || data?.code === 0;
              if (
                isSuccess &&
                url &&
                url.startsWith("http") &&
                !url.includes(".mp4")
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
                name: "bugpk-tencent-song",
                url: `${API_CONFIG.BUGPK_AGGREGATE}?media=tencent&type=song&id=${id}`,
                transform: (data) => {
                  if (
                    data?.url &&
                    data.url.startsWith("http") &&
                    !data.url.includes(".mp4")
                  ) {
                    return {
                      data: {
                        url: data.url,
                        lrc: data.lrc,
                      },
                      _source: "bugpk-tencent",
                    };
                  }
                  return null;
                },
              },
              {
                name: "gdstudio-tencent-song",
                url: `${API_CONFIG.GD_STUDIO_API}?types=url&source=tencent&id=${id}&br=320`,
                transform: (data) => {
                  if (
                    data?.url &&
                    data.url.startsWith("http") &&
                    !data.url.includes(".mp4") &&
                    !data.url.includes("版权") &&
                    !data.url.includes("不存在")
                  ) {
                    return {
                      data: { url: data.url },
                      _source: "gdstudio-tencent",
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
            {
              name: "bugpk-tencent-lyric",
              url: `${API_CONFIG.BUGPK_AGGREGATE}?media=tencent&type=song&id=${lyricId}`,
              transform: (data) => {
                if (data?.lrc_data && data.lrc_data.trim() !== "") {
                  return {
                    data: { lrc: data.lrc_data || "" },
                    _source: "bugpk-tencent",
                  };
                }
                return null;
              },
            },
            {
              name: "gdstudio-tencent-lyric",
              url: `${API_CONFIG.GD_STUDIO_API}?types=lyric&source=tencent&id=${lyricId}`,
              transform: (data) => {
                if (data?.lyric && data.lyric.trim() !== "") {
                  return {
                    data: {
                      lrc: data.lyric,
                      tlyric: data.tlyric || "",
                    },
                    _source: "gdstudio-tencent",
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

  console.log("[G-Player Proxy] ✓ 已启动");
}
