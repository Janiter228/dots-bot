import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_COOKIE = 'dots_panel_session';
const SESSION_SECONDS = 3600;
const ATTEMPT_WINDOW_MS = 60_000;
const ATTEMPT_LIMIT = 5;

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function createDashboardAccess({ tokenHash, passwordHash }) {
  const passwordConfig = /^([a-f0-9]{32}):([a-f0-9]{64})$/.exec(passwordHash ?? '');
  const enabled = /^[a-f0-9]{64}$/.test(tokenHash ?? '') && Boolean(passwordConfig);
  const sessions = new Map();
  let resetAttemptsAt = 0;
  let attempts = 0;

  function sessionKey(req) {
    const value = (req.headers.cookie ?? '').match(/(?:^|;\s*)dots_panel_session=([a-f0-9]{64})(?=;|$)/)?.[1];
    return value && hash(tokenHash + value);
  }

  function setCookie(req, res, value, maxAge) {
    const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
  }

  function getSession(req) {
    const session = sessions.get(sessionKey(req));
    return session?.expires > Date.now() ? session : undefined;
  }

  function startSession(req, res, project) {
    const now = Date.now();
    for (const [key, session] of sessions) {
      if (session.expires <= now) sessions.delete(key);
    }
    sessions.delete(sessionKey(req));
    const value = randomBytes(32).toString('hex');
    sessions.set(hash(tokenHash + value), { expires: now + SESSION_SECONDS * 1000, project });
    setCookie(req, res, value, SESSION_SECONDS);
  }

  function verifyPassword(res, password) {
    if (!passwordConfig) return 503;
    const now = Date.now();
    if (now >= resetAttemptsAt) {
      resetAttemptsAt = now + ATTEMPT_WINDOW_MS;
      attempts = 0;
    }
    if (attempts >= ATTEMPT_LIMIT) {
      res.setHeader('Retry-After', Math.ceil((resetAttemptsAt - now) / 1000));
      return 429;
    }
    attempts++;
    if (typeof password !== 'string' || !/^\d{4}$/.test(password)) return 401;
    const [, salt, expected] = passwordConfig;
    if (!timingSafeEqual(scryptSync(password, Buffer.from(salt, 'hex'), 32), Buffer.from(expected, 'hex'))) {
      return 401;
    }
    return 200;
  }

  return {
    enabled,
    hasSession(req) {
      return Boolean(getSession(req));
    },
    hasProjectSession(req) {
      return getSession(req)?.project === true;
    },
    startTokenSession(req, res) {
      startSession(req, res, false);
    },
    signIn(req, res, password) {
      const status = verifyPassword(res, password);
      if (status !== 200) return status;
      startSession(req, res, true);
      return 200;
    },
    signOut(req, res) {
      sessions.delete(sessionKey(req));
      setCookie(req, res, '', 0);
    },
  };
}
