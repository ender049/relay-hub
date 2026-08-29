(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelayAuthSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function cookieValue(cookieHeader, name) {
    const wanted = String(name || '').trim().toLowerCase();
    if (!wanted) return '';
    for (const part of String(cookieHeader || '').split(';')) {
      const index = part.indexOf('=');
      if (index <= 0) continue;
      if (part.slice(0, index).trim().toLowerCase() === wanted) return part.slice(index + 1).trim();
    }
    return '';
  }

  function singleCookieHeader(cookieHeader, name) {
    const value = cookieValue(cookieHeader, name);
    return value ? `${name}=${value}` : '';
  }

  function cookieWithoutName(cookieHeader, name) {
    const wanted = String(name || '').trim().toLowerCase();
    return cookiePairs(cookieHeader)
      .filter(([key]) => key.toLowerCase() !== wanted)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  function refreshTokenSid(value) {
    const token = String(value || '').trim();
    const separator = token.indexOf('.');
    if (separator <= 0 || separator === token.length - 1) return '';
    return token.slice(0, separator);
  }

  function resolveRefreshSession(cookieHeader, sessionId) {
    const value = cookieValue(cookieHeader, 'new_api_refresh');
    if (!value) throw new Error('缺少 NewAPI refresh cookie');
    const cookieSid = refreshTokenSid(value);
    if (!cookieSid) throw new Error('NewAPI refresh cookie 格式无效');
    const savedSid = String(sessionId || '').trim();
    if (savedSid && savedSid !== cookieSid) throw new Error('NewAPI refresh cookie 会话与渠道会话不匹配');
    return { cookie: `new_api_refresh=${value}`, sessionId: savedSid || cookieSid };
  }

  function splitSetCookieHeader(raw) {
    return String(raw || '').split(/,(?=\s*[^;,\s]+=)/).map(value => value.trim()).filter(Boolean);
  }

  function cookieExpired(setCookie, now) {
    const text = String(setCookie || '');
    const maxAge = text.match(/(?:^|;)\s*Max-Age\s*=\s*(-?\d+)/i);
    if (maxAge && Number(maxAge[1]) <= 0) return true;
    const expires = text.match(/(?:^|;)\s*Expires\s*=\s*([^;]+)/i);
    const timestamp = expires ? Date.parse(expires[1]) : NaN;
    return Number.isFinite(timestamp) && timestamp <= (now == null ? Date.now() : Number(now));
  }

  function cookiePairs(cookieHeader) {
    const pairs = [];
    for (const part of String(cookieHeader || '').split(';')) {
      const index = part.indexOf('=');
      if (index <= 0) continue;
      const name = part.slice(0, index).trim();
      if (name) pairs.push([name, part.slice(index + 1).trim()]);
    }
    return pairs;
  }

  function mergeSetCookies(cookieHeader, setCookies, now) {
    const jar = new Map(cookiePairs(cookieHeader));
    for (const raw of setCookies || []) {
      for (const text of splitSetCookieHeader(raw)) {
        const first = text.split(';', 1)[0];
        const index = first.indexOf('=');
        if (index <= 0) continue;
        const name = first.slice(0, index).trim();
        const value = first.slice(index + 1).trim();
        if (!name) continue;
        if (!value || cookieExpired(text, now)) jar.delete(name);
        else jar.set(name, value);
      }
    }
    return Array.from(jar, ([name, value]) => `${name}=${value}`).join('; ');
  }

  function authPayloadSucceeded(payload) {
    if (!payload || typeof payload !== 'object') return true;
    if ('success' in payload && payload.success !== true) return false;
    if ('code' in payload) {
      const code = Number(payload.code);
      return Number.isFinite(code) && (code === 0 || code === 200);
    }
    return true;
  }

  function allowPasswordLogin(options) {
    const opt = options || {};
    return opt.allowLogin !== false && opt.autoOnly !== true;
  }

  function bindAnchoredUserId(anchor, responseUserId) {
    const userId = String(responseUserId || '').trim();
    if (!userId) throw new Error('浏览器会话未返回用户标识');
    const current = String(anchor || '').trim();
    if (current && current !== userId) throw new Error('浏览器会话账号与渠道不一致');
    return userId;
  }

  function buildRefreshAuthState(current, candidate) {
    const previous = current || {};
    const next = candidate || {};
    const token = String(next.token || '').trim();
    const userId = String(next.userId || '').trim();
    const sessionId = String(next.sessionId || '').trim();
    const cookie = String(next.cookie || '').trim();
    if (!token || !userId || !sessionId || !cookie) {
      throw new Error('NewAPI 刷新成功但认证响应不完整');
    }
    const previousSessionId = String(previous.sessionId || '').trim();
    if (previousSessionId && previousSessionId !== sessionId) {
      throw new Error('NewAPI 刷新响应会话与渠道会话不匹配');
    }
    const cookieSession = resolveRefreshSession(cookie, sessionId);
    const previousUserId = String(previous.userId || '').trim();
    if (previousUserId && previousUserId !== userId) {
      throw new Error('NewAPI 刷新账号与渠道不一致');
    }
    return {
      cookie,
      token,
      userId,
      sessionId: cookieSession.sessionId,
      tokenAt: Number(next.tokenAt) || 0,
      tokenExpiresAt: Number(next.tokenExpiresAt) || 0
    };
  }

  function newApiAuthPlan(channel, options) {
    const c = channel || {};
    const plan = [];
    if (c.browserFetch === true && String(c.userId || '').trim()) plan.push('browser');
    if (c.systemReady === true) plan.push('system');
    if (c.sessionReady === true) plan.push('session');
    if (c.refreshReady === true) plan.push('refresh');
    if (c.loginReady === true && allowPasswordLogin(options)) plan.push('password');
    return plan;
  }

  function sub2ApiAuthPlan(channel, options) {
    const c = channel || {};
    const plan = [];
    if (c.browserFetch === true) plan.push('browser');
    if (c.tokenReady === true) plan.push('token');
    if (c.refreshReady === true) plan.push('refresh');
    if (c.loginReady === true && allowPasswordLogin(options)) plan.push('password');
    return plan;
  }

  function buildLoginAuthState(current, candidate, type) {
    const previous = current || {};
    const next = candidate || {};
    const token = String(next.token || '').trim();
    if (!token && type === 'sub2api') throw new Error('登录成功但未返回 token');
    if (type === 'newapi') {
      const userId = String(next.userId || '').trim();
      if (!userId) throw new Error('登录成功但未返回用户标识');
      return {
        cookie: String(next.cookie || previous.cookie || '').trim(),
        token,
        userId,
        sessionId: String(next.sessionId || '').trim(),
        tokenAt: Number(next.tokenAt) || 0,
        tokenExpiresAt: Number(next.tokenExpiresAt) || 0
      };
    }
    return {
      cookie: String(next.cookie || previous.cookie || '').trim(),
      token,
      refreshToken: String(next.refreshToken || previous.refreshToken || '').trim(),
      tokenAt: Number(next.tokenAt) || 0,
      tokenExpiresAt: Number(next.tokenExpiresAt) || 0
    };
  }

  function transactionError(primaryError, restoreErrors) {
    const failures = (restoreErrors || []).filter(Boolean);
    if (!failures.length) return primaryError;
    const restoreMessage = failures.map(error => error && error.message ? error.message : String(error)).join('; ');
    const primaryMessage = primaryError && (primaryError.message || String(primaryError));
    const error = new Error(primaryMessage
      ? `${primaryMessage}; Cookie 恢复失败: ${restoreMessage}`
      : `Cookie 恢复失败: ${restoreMessage}`);
    if (primaryError) error.cause = primaryError;
    error.restoreErrors = failures;
    return error;
  }

  async function withCookieTransaction(operations) {
    const ops = operations || {};
    const previous = await ops.capture();
    let started = false;
    let result;
    let observed;
    let installed = [];
    let primaryError = null;
    const restoreErrors = [];
    try {
      started = true;
      for (const cookie of previous) await ops.remove(cookie);
      installed = await ops.install() || [];
      if (!Array.isArray(installed)) installed = [installed];
      result = await ops.execute();
      observed = ops.read ? await ops.read(result) : undefined;
    } catch (error) {
      primaryError = error;
    } finally {
      if (started) {
        let current = [];
        try {
          current = await ops.capture();
        } catch (error) {
          restoreErrors.push(error);
          current = installed;
        }
        for (const cookie of current) {
          try { await ops.remove(cookie); } catch (error) { restoreErrors.push(error); }
        }
        for (const cookie of previous) {
          try { await ops.restore(cookie); } catch (error) { restoreErrors.push(error); }
        }
      }
    }
    const error = transactionError(primaryError, restoreErrors);
    if (error) throw error;
    return { result, observed };
  }

  return {
    allowPasswordLogin,
    authPayloadSucceeded,
    bindAnchoredUserId,
    buildLoginAuthState,
    buildRefreshAuthState,
    cookieExpired,
    cookieValue,
    cookieWithoutName,
    mergeSetCookies,
    newApiAuthPlan,
    refreshTokenSid,
    resolveRefreshSession,
    singleCookieHeader,
    splitSetCookieHeader,
    sub2ApiAuthPlan,
    withCookieTransaction
  };
});
