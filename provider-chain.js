export function createApiHealth({ now = Date.now, warn = console.warn } = {}) {
    const state = new Map();
    const customRules = new Map();
    const defaultRule = {
        threshold: 5,
        duration: 10 * 60 * 1000,
        label: "10 分钟",
    };

    return {
        state,
        customRules,
        defaultRule,
        setRule(name, rule) {
            customRules.set(name, rule);
        },
        getRule(name) {
            return customRules.get(name) || defaultRule;
        },
        isBlocked(name) {
            const current = state.get(name);
            if (!current) return false;
            if (current.blockUntil && now() < current.blockUntil) return true;
            if (current.blockUntil && now() >= current.blockUntil) {
                current.failCount = 0;
                current.blockUntil = 0;
            }
            return false;
        },
        recordSuccess(name) {
            const current = state.get(name);
            if (current && current.failCount > 0) {
                current.failCount = 0;
                current.blockUntil = 0;
            }
        },
        recordFailure(name) {
            let current = state.get(name);
            if (!current) {
                current = { failCount: 0, blockUntil: 0 };
                state.set(name, current);
            }
            current.failCount++;
            const rule = customRules.get(name) || defaultRule;
            if (current.failCount >= rule.threshold && !current.blockUntil) {
                current.blockUntil = now() + rule.duration;
                warn(
                    `[ApiHealth] ⛔ ${name} 连续失败 ${current.failCount} 次，熔断 ${rule.label}`,
                );
            }
        },
    };
}

export function parseExcludeProviders(value, { maxLength = 512, maxCount = 20 } = {}) {
    if (value === undefined || value === null || value === "") return new Set();
    if (typeof value !== "string" || value.length > maxLength) {
        throw new RangeError("Invalid excludeProviders parameter");
    }
    const names = value
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    if (names.length > maxCount) {
        throw new RangeError("Invalid excludeProviders parameter");
    }
    return new Set(names);
}

function providerErrorDetail(error, classification = null) {
    const payload = error?.response?.data;
    let upstream = "";
    if (typeof payload === "string") {
        try {
            const parsed = JSON.parse(payload);
            upstream = parsed?.msg || parsed?.message || "";
        } catch {
            upstream = payload;
        }
    } else if (payload && typeof payload === "object") {
        upstream = payload.msg || payload.message || payload.error || "";
    }
    let detail = classification?.message || upstream || error?.message || "未知错误";
    if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT") {
        const timeout = Number(error?.config?.timeout) || 0;
        detail = timeout ? `请求超时（${timeout}ms）` : "请求超时";
    }
    return String(detail)
        .replace(new RegExp("https?://" + "\\S+", "gi"), "上游地址")
        .replace(new RegExp("\\s+", "g"), " ")
        .trim()
        .slice(0, 240);
}

export async function tryProviderChain({
    apis,
    excludeProviders = new Set(),
    emptyIsFailure = false,
    request,
    health,
    warn = console.warn,
}) {
    const attemptedProviders = [];
    let hasUpstreamFailure = false;

    const recordContentMiss = (name) => {
        if (emptyIsFailure) {
            hasUpstreamFailure = true;
            health.recordFailure(name);
        } else {
            health.recordSuccess(name);
        }
    };

    for (const api of apis) {
        if (excludeProviders.has(api.name)) continue;
        if (health.isBlocked(api.name)) {
            hasUpstreamFailure = true;
            continue;
        }
        attemptedProviders.push(api.name);

        try {
            const response = await request(api);
            const transformed = api.transform
                ? api.transform(response.data)
                : response.data;
            if (transformed === null) {
                recordContentMiss(api.name);
                continue;
            }
            if (api.validate && !(await api.validate(transformed))) {
                recordContentMiss(api.name);
                continue;
            }
            const hasData =
                transformed?.data &&
                (Array.isArray(transformed.data)
                    ? transformed.data.length > 0
                    : true);
            if (hasData) {
                health.recordSuccess(api.name);
                return {
                    result: transformed,
                    provider: api.name,
                    attemptedProviders,
                    failureKind: null,
                };
            }
            recordContentMiss(api.name);
        } catch (error) {
            const classification = api.classifyError
                ? api.classifyError(error)
                : null;
            const status = error.response?.status;
            const code = error.code;
            const detail = providerErrorDetail(error, classification);
            if (classification?.kind === "unavailable") {
                warn(
                    `[API] ${api.name} 不可用 reason=${classification.reason || "request_rejected"} status=${status || "无"} code=${code || "无"} detail=${detail}（不计入熔断）`,
                );
                continue;
            }
            hasUpstreamFailure = true;
            health.recordFailure(api.name);
            const reason =
                code === "ECONNABORTED" || code === "ETIMEDOUT"
                    ? "timeout"
                    : status >= 500
                      ? "upstream_5xx"
                      : "transport";
            warn(
                `[API] ${api.name} 失败 reason=${reason} status=${status || "无"} code=${code || "无"} detail=${detail}`,
            );
        }
    }

    return {
        result: null,
        provider: null,
        attemptedProviders,
        failureKind: hasUpstreamFailure ? "upstream" : "unavailable",
    };
}

export function addProviderMetadata(result, chainResult) {
    return {
        ...result,
        ...(chainResult.provider ? { _provider: chainResult.provider } : {}),
        _attemptedProviders: chainResult.attemptedProviders,
        ...(chainResult.failureKind
            ? { _failure: { kind: chainResult.failureKind } }
            : {}),
    };
}
