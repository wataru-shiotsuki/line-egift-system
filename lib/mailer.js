const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
async function notifyStaff({ productName, orderedAt, giftToken, lineUserId, method }) {
  if (!resend || !process.env.NOTIFICATION_EMAIL) {
    console.warn('[mailer] RESEND_API_KEY または NOTIFICATION_EMAIL が未設定のため通知をスキップ');
    return;
  }
  const orderedAtJst = new Date(orderedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  await resend.emails.send({
    from: process.env.NOTIFICATION_FROM || 'Giftalk <onboarding@resend.dev>',
    to: process.env.NOTIFICATION_EMAIL,
    subject: `【受け取り】${productName}`,
    text:
      `ギフトが受け取られました。\n\n` +
      `商品名: ${productName}\n` +
      `注文日時: ${orderedAtJst}\n` +
      `ギフトToken: ${giftToken}\n` +
      `受取人LINE userId: ${lineUserId || '(未取得)'}\n` +
      `受け取り方法: ${method}\n`,
  });
}
module.exports = { notifyStaff };