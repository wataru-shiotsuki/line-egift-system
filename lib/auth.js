function adminAuth(req, res) {
  const auth = req.headers.authorization;
  if (!auth) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    res.status(401).send('認証が必要です');
    return false;
  }
  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (user === process.env.ADMIN_USER && pass === process.env.ADMIN_PASS) return true;
  res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
  res.status(401).send('認証失敗');
  return false;
}
module.exports = adminAuth;