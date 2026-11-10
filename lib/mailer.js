

const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;


async function sendWithRetry(payload) {
  try {
    const result = await resend.emails.send(payload);
    if (!result.error) return result;
  } catch (e) {  }
  await new Promise(r => setTimeout(r, 1000));
  return resend.emails.send(payload);
}


async function notifyStaff({ productName, orderedAt, giftToken, lineUserId, method, address, isChangeRequest = false }) {
  if (!resend || !process.env.NOTIFICATION_EMAIL) {
    console.warn('[mailer] RESEND_API_KEY または NOTIFICATION_EMAIL が未設定のため通知をスキップ');
    return;
  }
  const orderedAtJst = new Date(orderedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const subject = isChangeRequest ? `【変更依頼】${productName}` : `【在庫確認】${productName}`;
  const intro = isChangeRequest ? '受取人から変更依頼がありました（商品はまだ受け取られていません）。' : '受取人が商品を選びました。在庫をご確認ください。';
  const { error } = await sendWithRetry({
    from: process.env.NOTIFICATION_FROM || 'Giftalk <onboarding@resend.dev>',
    to: process.env.NOTIFICATION_EMAIL,
    subject,
    text:
      `${intro}\n\n` +
      `商品名: ${productName}\n` +
      `注文日時: ${orderedAtJst}\n` +
      `ギフトToken: ${giftToken}\n` +
      `受取人LINE userId: ${lineUserId || '(未取得)'}\n` +
      `受け取り方法: ${method}\n` +
      (address ? `お届け先: ${address}\n` : ''),
  });
  if (error) throw new Error(`Resend API error: ${error.message || JSON.stringify(error)}`);
}


async function notifyCustomer({ to, subject, text }) {
  if (!resend || !to) return;
  const { error } = await sendWithRetry({
    from: process.env.NOTIFICATION_FROM || 'Giftalk <onboarding@resend.dev>',
    to,
    subject,
    text,
  });
  if (error) throw new Error(`Resend API error: ${error.message || JSON.stringify(error)}`);
}

module.exports = { notifyStaff, notifyCustomer };
