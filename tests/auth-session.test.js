const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../src/auth-session.js');

test('extracts only the requested refresh cookie', () => {
  const header = 'session=old; new_api_refresh=sid-1.secret-1; theme=dark';
  assert.equal(auth.cookieValue(header, 'new_api_refresh'), 'sid-1.secret-1');
  assert.equal(auth.singleCookieHeader(header, 'new_api_refresh'), 'new_api_refresh=sid-1.secret-1');
});

test('ordinary cookie selection excludes the refresh cookie', () => {
  const header = 'session=old; new_api_refresh=sid-1.secret-1; theme=dark';
  assert.equal(auth.cookieWithoutName(header, 'new_api_refresh'), 'session=old; theme=dark');
});

test('parses the SID from a refresh token', () => {
  assert.equal(auth.refreshTokenSid('sid-123.secret.value'), 'sid-123');
  assert.equal(auth.refreshTokenSid('missing-secret.'), '');
  assert.equal(auth.refreshTokenSid('missing-separator'), '');
});

test('binds an empty session and rejects a SID mismatch', () => {
  assert.deepEqual(auth.resolveRefreshSession('new_api_refresh=sid-1.secret', ''), {
    cookie: 'new_api_refresh=sid-1.secret',
    sessionId: 'sid-1'
  });
  assert.throws(
    () => auth.resolveRefreshSession('new_api_refresh=sid-2.secret', 'sid-1'),
    /会话与渠道会话不匹配/
  );
});

test('splits and merges rotated and deleted Set-Cookie values with Expires commas', () => {
  const combined = 'new_api_refresh=sid-1.rotated; Path=/api/user/auth; Expires=Wed, 21 Oct 2099 07:28:00 GMT, session=next; Path=/';
  assert.deepEqual(auth.splitSetCookieHeader(combined), [
    'new_api_refresh=sid-1.rotated; Path=/api/user/auth; Expires=Wed, 21 Oct 2099 07:28:00 GMT',
    'session=next; Path=/'
  ]);
  assert.equal(
    auth.mergeSetCookies('new_api_refresh=sid-1.old; session=old', [combined]),
    'new_api_refresh=sid-1.rotated; session=next'
  );
  assert.equal(
    auth.mergeSetCookies('new_api_refresh=sid-1.old; session=old', [
      'new_api_refresh=; Path=/api/user/auth; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    ]),
    'session=old'
  );
});

test('recognizes current and legacy successful auth payloads', () => {
  assert.equal(auth.authPayloadSucceeded({ success: true, data: {} }), true);
  assert.equal(auth.authPayloadSucceeded({ code: 0, data: {} }), true);
  assert.equal(auth.authPayloadSucceeded({ code: 200, data: {} }), true);
  assert.equal(auth.authPayloadSucceeded({ success: false, code: 'AUTH_SESSION_MISMATCH' }), false);
});

test('auto-only refresh policy never permits password login', () => {
  assert.equal(auth.allowPasswordLogin({ autoOnly: true }), false);
  assert.equal(auth.allowPasswordLogin({ autoOnly: false }), true);
  assert.equal(auth.allowPasswordLogin({ allowLogin: false }), false);
});

test('browser session binding requires and preserves the user anchor', () => {
  assert.equal(auth.bindAnchoredUserId('42', '42'), '42');
  assert.throws(() => auth.bindAnchoredUserId('42', ''), /未返回用户标识/);
  assert.throws(() => auth.bindAnchoredUserId('42', '43'), /账号与渠道不一致/);
});

test('refresh authentication state validates every identity before returning a commit', () => {
  const current = { userId: '42', sessionId: 'sid-1', token: 'old', cookie: 'new_api_refresh=sid-1.old' };
  const next = auth.buildRefreshAuthState(current, {
    token: 'next', userId: '42', sessionId: 'sid-1',
    cookie: 'session=x; new_api_refresh=sid-1.rotated', tokenAt: 10, tokenExpiresAt: 20
  });
  assert.deepEqual(next, {
    cookie: 'session=x; new_api_refresh=sid-1.rotated', token: 'next', userId: '42',
    sessionId: 'sid-1', tokenAt: 10, tokenExpiresAt: 20
  });
  assert.throws(() => auth.buildRefreshAuthState(current, { ...next, sessionId: 'sid-2' }), /渠道会话不匹配/);
  assert.throws(() => auth.buildRefreshAuthState(current, { ...next, cookie: 'new_api_refresh=sid-2.rotated' }), /cookie 会话/);
  assert.throws(() => auth.buildRefreshAuthState(current, { ...next, userId: '43' }), /账号与渠道不一致/);
  assert.throws(() => auth.buildRefreshAuthState({ ...current, sessionId: 'sid-0' }, next), /渠道会话不匹配/);
  assert.deepEqual(current, { userId: '42', sessionId: 'sid-1', token: 'old', cookie: 'new_api_refresh=sid-1.old' });
});

test('NewAPI orchestration requires an anchor and omits password during auto-only refresh', () => {
  const channel = { browserFetch: true, userId: '', systemReady: true, sessionReady: true, refreshReady: true, loginReady: true };
  assert.deepEqual(auth.newApiAuthPlan(channel, { autoOnly: false }), ['system', 'session', 'refresh', 'password']);
  assert.deepEqual(auth.newApiAuthPlan({ ...channel, userId: '42' }, { autoOnly: true }), ['browser', 'system', 'session', 'refresh']);
});

test('Sub2API auto-only orchestration reuses token and refresh without password login', () => {
  const channel = { browserFetch: true, tokenReady: true, refreshReady: true, loginReady: true };
  assert.deepEqual(auth.sub2ApiAuthPlan(channel, { autoOnly: true }), ['browser', 'token', 'refresh']);
  assert.deepEqual(auth.sub2ApiAuthPlan(channel, { autoOnly: false }), ['browser', 'token', 'refresh', 'password']);
});

test('login authentication state validates before returning an atomic commit', () => {
  const current = { cookie: 'session=old', token: 'old-token', userId: '42' };
  assert.throws(() => auth.buildLoginAuthState(current, { cookie: 'session=new', token: 'new-token' }, 'newapi'), /用户标识/);
  assert.deepEqual(current, { cookie: 'session=old', token: 'old-token', userId: '42' });
  assert.deepEqual(auth.buildLoginAuthState(current, { cookie: 'session=new', token: 'new-token', userId: '42', sessionId: 'sid' }, 'newapi'), {
    cookie: 'session=new', token: 'new-token', userId: '42', sessionId: 'sid', tokenAt: 0, tokenExpiresAt: 0
  });
});

function transactionOps(failAt) {
  const events = [];
  let captureCount = 0;
  const error = step => new Error(`${step} failed`);
  return {
    events,
    operations: {
      capture: async () => {
        events.push('capture');
        captureCount += 1;
        if (failAt === 'read' && captureCount === 2) throw error('read');
        return captureCount === 1 ? ['old-a', 'old-b'] : ['temporary'];
      },
      remove: async cookie => {
        events.push(`remove:${cookie}`);
        if (failAt === 'remove' && cookie === 'old-b') throw error('remove');
      },
      install: async () => {
        events.push('install');
        if (failAt === 'install') throw error('install');
        return ['temporary'];
      },
      execute: async () => {
        events.push('execute');
        if (failAt === 'execute') throw error('execute');
        return 'response';
      },
      read: async () => {
        events.push('read');
        if (failAt === 'observe') throw error('observe');
        return 'rotated';
      },
      restore: async cookie => {
        events.push(`restore:${cookie}`);
        if (failAt === 'restore' && cookie === 'old-a') throw error('restore');
      }
    }
  };
}

for (const [failure, pattern] of [['remove', /remove failed/], ['install', /install failed/], ['execute', /execute failed/], ['observe', /observe failed/], ['read', /read failed/], ['restore', /Cookie 恢复失败/]]) {
  test(`cookie transaction restores the jar after ${failure} failure`, async () => {
    const fixture = transactionOps(failure);
    await assert.rejects(auth.withCookieTransaction(fixture.operations), pattern);
    assert.ok(fixture.events.includes('restore:old-a'));
    assert.ok(fixture.events.includes('restore:old-b'));
    if (failure === 'read') assert.ok(fixture.events.includes('remove:temporary'));
  });
}

test('cookie transaction returns the rotated cookie after success', async () => {
  const fixture = transactionOps('');
  assert.deepEqual(await auth.withCookieTransaction(fixture.operations), { result: 'response', observed: 'rotated' });
  assert.ok(fixture.events.indexOf('read') < fixture.events.indexOf('restore:old-a'));
});
