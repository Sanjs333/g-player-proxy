import axios from "axios";

export const info = {
  id: "g-player-proxy",
  name: "G-Player Music Proxy",
  description: "为 G-Player 音乐播放器提供多音源代理支持。",
};

const API_CONFIG = {
  VKEYS_NETEASE_SEARCH: "https://api.vkeys.cn/v2/music/netease?word=",
  VKEYS_TENCENT_SEARCH: "https://api.vkeys.cn/v2/music/tencent?word=",
  VKEYS_TENCENT_SONG: "https://api.vkeys.cn/v2/music/tencent?id=",
  VKEYS_TENCENT_LYRIC: "https://api.vkeys.cn/v2/music/tencent/lyric?id=",
  VKEYS_NETEASE_LYRIC: "https://api.vkeys.cn/v2/music/netease/lyric?id=",
  VKEYS_KUWO_LYRIC: "https://api.vkeys.cn/v2/music/kuwo/lyric?id=",
  BUGPK_NETEASE_SONG: "https://api.bugpk.com/api/163_music",
  BUGPK_AGGREGATE: "https://api.bugpk.com/api/music",
  OPEN_MUSIC_API_URL: "https://open-music-server.pages.dev/api/music",
  OPEN_MUSIC_API_TOKEN:
    "ark-6VY6nBX2QgL3HEu9yFR5-zhrFHMLfhr-9LVk2Y5ecAH3ALAMHnrObY-KMXIMqN_WMniBlkluIPsyVfu22rhRZyRjQXng4ecBrzrwaurGKrHdVXJGOlt5RxnOnho1BFTQ",
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
          ]);
          break;

        case "tencent":
        default:
          result = await tryMultipleAPIs([
            {
              name: "vkeys-tencent-search",
              url: `${API_CONFIG.VKEYS_TENCENT_SEARCH}${encodeURIComponent(query)}`,
              transform: (data) => data,
            },
            {
              name: "bugpk-tencent-search",
              url: `${API_CONFIG.BUGPK_AGGREGATE}?media=tencent&type=search&word=${encodeURIComponent(query)}`,
              transform: (data) => data,
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
                if (data?.url && data?.status === 200) {
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
                if (data?.url) {
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
          ]);
          break;

        case "tencent":
        default:
          result = await tryMultipleAPIs([
            {
              name: "vkeys-tencent-song",
              url: `${API_CONFIG.VKEYS_TENCENT_SONG}${id}`,
              transform: (data) => data,
              validate: (data) => {
                const url = data?.data?.url;
                if (url && url.includes(".mp4")) return false;
                return !!url;
              },
            },
            {
              name: "bugpk-tencent-song",
              url: `${API_CONFIG.BUGPK_AGGREGATE}?media=tencent&type=song&id=${id}`,
              transform: (data) => {
                if (data?.url && !data.url.includes(".mp4")) {
                  return {
                    data: { url: data.url, lrc: data.lrc },
                    _source: "bugpk-tencent",
                  };
                }
                return null;
              },
            },
          ]);

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
          ]);
          break;

        case "tencent":
        default:
          result = await tryMultipleAPIs([
            {
              name: "vkeys-tencent-lyric",
              url: `${API_CONFIG.VKEYS_TENCENT_LYRIC}${id}`,
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
              url: `${API_CONFIG.BUGPK_AGGREGATE}?media=tencent&type=song&id=${id}`,
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
          ]);
          break;
      }

      if (!result && title) {
        const query = artist ? `${title} ${artist}` : title;

        try {
          const searchRes = await axios.get(
            `${API_CONFIG.OPEN_MUSIC_API_URL}?provider=kw&name=${encodeURIComponent(query)}&page=1&limit=1&token=${API_CONFIG.OPEN_MUSIC_API_TOKEN}`,
            {
              headers: { token: API_CONFIG.OPEN_MUSIC_API_TOKEN },
              timeout: 10000,
            },
          );

          if (searchRes.data?.code === 200 && searchRes.data?.data) {
            const list = Array.isArray(searchRes.data.data)
              ? searchRes.data.data
              : [searchRes.data.data];

            if (list.length > 0 && (list[0].rid || list[0].id)) {
              const songId = list[0].rid || list[0].id;

              const lyrRes = await axios.get(
                `${API_CONFIG.OPEN_MUSIC_API_URL}?provider=kw&id=${songId}&type=lyr&format=all&token=${API_CONFIG.OPEN_MUSIC_API_TOKEN}`,
                {
                  headers: {
                    token: API_CONFIG.OPEN_MUSIC_API_TOKEN,
                  },
                  timeout: 10000,
                },
              );

              if (lyrRes.data?.code === 200 && lyrRes.data?.data) {
                let lrcContent = "";
                if (
                  lyrRes.data.data.lrclist &&
                  Array.isArray(lyrRes.data.data.lrclist)
                ) {
                  lrcContent = convertLrclistToLrc(lyrRes.data.data.lrclist);
                } else {
                  lrcContent =
                    lyrRes.data.data.lyric || lyrRes.data.data.lrc || "";
                }

                if (lrcContent && lrcContent.trim() !== "") {
                  result = {
                    data: { lrc: lrcContent },
                    _source: "openmusic-kw-by-name",
                  };
                }
              }
            }
          }
        } catch (fallbackErr) {
          console.error(
            "[G-Player Proxy] 歌词 fallback 失败:",
            fallbackErr.message,
          );
        }
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

  console.log("[G-Player Proxy] ✓ 已启动");
}
