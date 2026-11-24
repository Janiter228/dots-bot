import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_COOKIE = 'dots_dashboard_session';
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
    const value = (req.headers.cookie ?? '').match(/(?:^|;\s*)dots_dashboard_session=([a-f0-9]{64})(?=;|$)/)?.[1];
    return value && hash(tokenHash + value);
  }

  function setCookie(req, res, value, maxAge) {
    const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${value}; Path=/api; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
  }

  return {
    enabled,
    hasSession(req) {
      return sessions.get(sessionKey(req)) > Date.now();
    },
    signIn(req, res, password) {
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
      for (const [key, expires] of sessions) {
        if (expires <= now) sessions.delete(key);
      }
      sessions.delete(sessionKey(req));
      const value = randomBytes(32).toString('hex');
      sessions.set(hash(tokenHash + value), now + SESSION_SECONDS * 1000);
      setCookie(req, res, value, SESSION_SECONDS);
      return 200;
    },
    signOut(req, res) {
      sessions.delete(sessionKey(req));
      setCookie(req, res, '', 0);
    },
  };
}

export function addDashboardAccessControls(html) {
  return html.replace(
    '          </form>\n          <label id="follow-label"',
    `            <button id="project-access" type="button" style="margin-top: .5rem">Наш токен</button>
          </form>
          <dialog id="project-access-dialog" aria-labelledby="project-access-label" style="max-width:calc(100% - 2rem); background:var(--surface); color:var(--ink); border:1px solid var(--line); border-radius:.5rem">
            <form id="project-access-form" autocomplete="off">
              <label id="project-access-label" for="project-password">Пароль для нашего токена</label>
              <div class="auth-entry">
                <input id="project-password" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" required autofocus>
                <button type="submit" class="primary">Активировать</button>
                <button id="project-access-cancel" type="button">Отмена</button>
              </div>
              <p id="project-access-error" class="notice" role="status" hidden></p>
            </form>
          </dialog>
          <label id="follow-label"`
  ).replace(
    '(!token && !checkAvailability)',
    '(!token && !authenticated && !checkAvailability)'
  ).replace(
    'error.status === 401 && !token',
    'error.status === 401 && !token && !authenticated'
  ).replace(
    "byId('logout').addEventListener('click', () => {",
    `byId('logout').addEventListener('click', async () => {
      try {
        await fetchJson('/api/dashboard-session/logout', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
        });
      } catch {
        notice('game-message', 'Не удалось выйти. Попробуйте ещё раз.');
        return;
      }`
  ).replace(
    '    schedule();\n    refreshGames(false, true);',
    `    const accessDialog = byId('project-access-dialog');
    const accessPassword = byId('project-password');
    const accessSubmit = byId('project-access-form').querySelector('[type=submit]');
    byId('project-access').addEventListener('click', () => {
      accessPassword.value = '';
      notice('project-access-error', '');
      accessDialog.showModal();
    });
    byId('project-access-cancel').addEventListener('click', () => accessDialog.close());
    accessDialog.addEventListener('cancel', (event) => {
      if (accessSubmit.disabled) event.preventDefault();
    });
    byId('project-access-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const password = accessPassword.value;
      accessPassword.value = '';
      accessSubmit.disabled = true;
      byId('project-access-cancel').disabled = true;
      notice('project-access-error', '');
      try {
        await fetchJson('/api/dashboard-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
        token = '';
        byId('token').value = '';
        accessDialog.close();
        await refreshGames(true, true);
      } catch (error) {
        notice('project-access-error', error.status === 401 ? 'Неверный пароль' :
          error.status === 429 ? 'Слишком много попыток. Попробуйте через минуту.' : 'Вход сейчас недоступен.');
        accessPassword.focus();
      } finally {
        accessSubmit.disabled = false;
        byId('project-access-cancel').disabled = false;
      }
    });
    schedule();
    refreshGames(false, true);`
  );
}
