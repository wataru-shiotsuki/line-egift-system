const loginAttempts = new Map();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + WINDOW_MS };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + WINDOW_MS; }
  entry.count++;
  loginAttempts.set(ip, entry);
  return entry.count > MAX_ATTEMPTS;
}

function adminAuth(req, res) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
  if (checkRateLimit(ip)) {
    res.status(429).send('試行回数が多すぎます。15分後に再度お試しください。');
    return false;
  }
  const auth = req.headers.authorization;
  if (!auth) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    res.status(401).send('認証が必要です');
    return false;
  }
  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (user === process.env.ADMIN_USER && pass === process.env.ADMIN_PASS) {
    loginAttempts.delete(ip);
    return true;
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
  res.status(401).send('認証失敗');
  return false;
}

module.exports = adminAuth;
