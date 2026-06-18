const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const supabase = require('../lib/supabase');
const lineClient = require('../lib/line');
const adminAuth = require('../lib/auth');
const genAI = require('../lib/gemini');
const { getActiveProducts, invalidateProductsCache } = require('../lib/products');
const { buildClaimedFlex } = require('../lib/flex');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { notifyStaff } = require('../lib/mailer');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
const router = express.Router();
const giftalkCors = cors({ origin: '*' });
['/create-payment-intent', '/gift-data', '/gift-select', '/gift-address', '/gift-receive', '/ai-chat'].forEach(p => {
  router.options(p, giftalkCors);
  router.use(p, giftalkCors);
});
router.get('/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});
router.get('/products', async (req, res) => {
  const allProducts = await getActiveProducts();
  const list = Object.entries(allProducts).map(([id, p]) => ({
    id, name: p.name, amount: p.amount, description: p.description, category: p.category,
  }));
  res.json(list);
});
router.post('/ai-chat', async (req, res) => {
  const { messages, lineUserId } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages required' });
  }
  try {
    const allProducts = await getActiveProducts();
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: `あなたはギフト選びの相談に乗るアシスタントです。
ユーザーは誰かにプレゼントを贈りたくてここに来ています。
【重要：会話は最短で】
・ユーザーが「誕生日」「お礼」「記念日」などシーンを伝えてきたら、追加の質問はせず、予算だけ軽く聞くかそのまま商品を提案してください。
・予算も言及があれば質問不要。すぐ2〜3個提案してください。
・目標は1〜2往復で商品提案まで届けることです。
・「何がいいかな」など完全に曖昧な場合だけ、1つだけ質問して絞り込んでください。
贈る相手・シーン・予算が少しでもわかったら積極的に提案してください。
提案するときは必ず【商品リストに記載されている正確な商品名（例：スターバックスカード 1,000円）】をそのまま使ってください。
略称・別表現は使わないでください。
マークダウン（**太字**や*斜体*など）は絶対に使わないでください。プレーンテキストのみで返答してください。
【取り扱い商品リスト】
${Object.values(allProducts).map(p => `・${p.name}（${p.amount}円） - ${p.description}`).join('\n')}
自然な日本語で短めに返答してください。`,
    });
    const priorMessages = messages.slice(0, -1);
    const firstUserIdx = priorMessages.findIndex(m => m.role === 'user');
    const history = (firstUserIdx === -1 ? [] : priorMessages.slice(firstUserIdx)).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const lastMessage = messages[messages.length - 1].content;
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(lastMessage);
    const aiText = result.response.text().trim();
    const recommendations = Object.entries(allProducts)
      .filter(([, p]) => aiText.includes(p.name))
      .map(([id]) => id);
    supabase.from('conversation_logs').insert({
      user_id: lineUserId || null,
      user_message: lastMessage,
      ai_response: aiText,
      recommendations,
      source: 'liff_chat',
    }).then(() => {}).catch(err => console.error('conversation_logs insert error:', err));
    if (lineUserId && recommendations.length > 0) {
      supabase.from('funnel_events').insert(
        recommendations.map(productId => ({ user_id: lineUserId, event_type: 'rec_view', product_id: productId }))
      ).then(() => {}).catch(err => console.error('funnel_events insert error:', err));
    }
    res.json({ message: aiText, recommendations });
  } catch (err) {
    console.error('[ai-chat] error:', err);
    res.status(500).json({ error: 'AI応答の取得に失敗しました' });
  }
});
router.post('/funnel-event', async (req, res) => {
  const { userId, eventType, productId } = req.body;
  if (!eventType) return res.status(400).json({ error: 'eventType required' });
  try {
    await supabase.from('funnel_events').insert({ user_id: userId || null, event_type: eventType, product_id: productId || null });
  } catch (err) {
    console.error('Funnel event error:', err);
  }
  res.sendStatus(200);
});
router.post('/create-payment-intent', async (req, res) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const { productId, lineUserId, giftMessage, giftType, items, senderName, occasionText, presentationStyle, payload } = req.body;
  if (giftType === 'giftalk') {
    if (!Array.isArray(items) || items.length < 1 || items.length > 6) {
      return res.status(400).json({ error: 'items は1〜6件必要です' });
    }
    try {
      const maxPrice = Math.max(...items.map(i => Number(i.price) || 0));
      if (maxPrice <= 0) return res.status(400).json({ error: '商品価格が不正です' });
      if (!items.every(i => Number(i.price) === maxPrice)) {
        return res.status(400).json({ error: '選択できるのは同じ価格の商品のみです' });
      }
      const giftId = 'GT-' + Date.now().toString(36).toUpperCase() +
                     Math.random().toString(36).slice(2, 5).toUpperCase();
      const itemsWithId = items.map((it, i) => ({ ...it, id: String(it.id != null ? it.id : i) }));
      await supabase.from('gifts').insert({
        gift_id: giftId,
        sender_name: String(senderName || '').slice(0, 20) || '名無し',
        occasion_text: String(occasionText || '').slice(0, 300),
        items: itemsWithId,
        payload: payload || null,
        presentation_style: ['celebrate','heartfelt','gratitude','casual'].includes(presentationStyle)
          ? presentationStyle : 'celebrate',
        line_user_id: lineUserId || null,
        status: 'pending',
      });
      const paymentIntent = await stripe.paymentIntents.create({
        amount: maxPrice,
        currency: 'jpy',
        metadata: { giftType: 'giftalk', giftId, lineUserId: lineUserId || '' },
      });
      return res.json({ clientSecret: paymentIntent.client_secret, giftId });
    } catch (err) {
      console.error('Giftalk PaymentIntent error:', err);
      return res.status(500).json({ error: '決済の準備に失敗しました。時間をおいて再度お試しください。' });
    }
  }
  const allProducts = await getActiveProducts();
  const product = allProducts[productId];
  if (!product || !lineUserId) {
    return res.status(400).json({ error: '商品情報が取得できませんでした。再度お試しください。' });
  }
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: product.amount,
      currency: product.currency || 'jpy',
      metadata: { lineUserId, productId, giftMessage: (giftMessage || '').slice(0, 500) },
    });
    supabase.from('funnel_events').insert({ user_id: lineUserId, event_type: 'payment_init', product_id: productId }).then(() => {}).catch(console.error);
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('PaymentIntent error:', err);
    res.status(500).json({ error: '決済の準備に失敗しました。時間をおいて再度お試しください。' });
  }
});
router.get('/gift-data', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  const { data, error } = await supabase.from('gifts').select('*').eq('gift_id', id).maybeSingle();
  if (error || !data) return res.status(404).json({ ok: false, error: 'Gift not found' });
  res.json({ ok: true, gift: data });
});
router.post('/gift-select', async (req, res) => {
  const { giftId, selectedItemId } = req.body;
  if (!giftId || !selectedItemId) return res.status(400).json({ ok: false, error: 'giftId and selectedItemId required' });
  const { data: existing } = await supabase.from('gifts').select('selected_item_id, status').eq('gift_id', giftId).maybeSingle();
  if (!existing) return res.status(404).json({ ok: false, error: 'Gift not found' });
  if (existing.status === 'refunded') return res.status(403).json({ ok: false, error: 'refunded' });
  const { data: claimed } = await supabase.from('gifts')
    .update({ selected_item_id: String(selectedItemId).slice(0, 64), selected_at: new Date().toISOString(), status: 'selected' })
    .eq('gift_id', giftId).is('selected_item_id', null).select('gift_id');
  if (!claimed || claimed.length === 0) return res.status(409).json({ ok: false, error: 'Already selected' });
  res.json({ ok: true });
});
router.post('/gift-address', async (req, res) => {
  const { giftId, address } = req.body;
  if (!giftId) return res.status(400).json({ ok: false, error: 'giftId required' });
  const { data: gift } = await supabase.from('gifts').select('*').eq('gift_id', giftId).maybeSingle();
  if (!gift) return res.status(404).json({ ok: false, error: 'Gift not found' });
  await supabase.from('gifts')
    .update({ recipient_address: address || null, status: 'completed', fulfillment_method: 'shipping' })
    .eq('gift_id', giftId);
  const items = Array.isArray(gift.items) ? gift.items : [];
  const item = items.find(i => String(i.id) === String(gift.selected_item_id)) || items[0] || {};
  notifyStaff({
    productName: item.name || 'ギフト',
    orderedAt: new Date().toISOString(),
    giftToken: gift.gift_id,
    lineUserId: gift.line_user_id,
    method: '配送（住所入力）',
  }).catch(err => console.error('notifyStaff error:', err));
  res.json({ ok: true });
});
router.post('/gift-receive', async (req, res) => {
  const { giftId, selectedItemId } = req.body;
  if (!giftId) return res.status(400).json({ ok: false, error: 'giftId required' });
  const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;
  try {
    const { data: gift } = await supabase.from('gifts').select('*').eq('gift_id', giftId).maybeSingle();
    if (!gift) return res.status(404).json({ ok: false, error: 'Gift not found' });
    if (gift.status === 'refunded') return res.status(403).json({ ok: false, error: 'refunded' });
    if (gift.qr_token) {
      const verifyUrl = `${baseUrl}/gift/verify?token=${gift.qr_token}`;
      const qrDataUrl = await QRCode.toDataURL(verifyUrl);
      return res.json({ ok: true, used: true, qrDataUrl, verifyUrl });
    }
    const qrToken = crypto.randomUUID();
    const now = new Date().toISOString();
    const selId = selectedItemId != null ? String(selectedItemId).slice(0, 64) : gift.selected_item_id;
    const { data: claimed } = await supabase.from('gifts')
      .update({
        selected_item_id: selId,
        selected_at: gift.selected_at || now,
        fulfillment_method: 'pickup',
        qr_token: qrToken,
        qr_status: 'issued',
      })
      .eq('gift_id', giftId).is('qr_token', null).select('gift_id');
    if (!claimed || claimed.length === 0) {
      const { data: g2 } = await supabase.from('gifts').select('qr_token').eq('gift_id', giftId).maybeSingle();
      const verifyUrl = `${baseUrl}/gift/verify?token=${g2?.qr_token || ''}`;
      const qrDataUrl = g2?.qr_token ? await QRCode.toDataURL(verifyUrl) : undefined;
      return res.json({ ok: true, used: true, qrDataUrl, verifyUrl });
    }
    const verifyUrl = `${baseUrl}/gift/verify?token=${qrToken}`;
    const qrDataUrl = await QRCode.toDataURL(verifyUrl);
    const items = Array.isArray(gift.items) ? gift.items : [];
    const item = items.find(i => String(i.id) === String(selId)) || items[0] || {};
    notifyStaff({
      productName: item.name || 'ギフト',
      orderedAt: now,
      giftToken: qrToken,
      lineUserId: gift.line_user_id,
      method: '店頭受け取り',
    }).catch(err => console.error('notifyStaff error:', err));
    res.json({ ok: true, qrDataUrl, verifyUrl, giftToken: qrToken });
  } catch (err) {
    console.error('gift-receive error:', err);
    res.status(500).json({ ok: false, error: 'server error' });
  }
});
router.get('/get-gift-url', async (req, res) => {
  const { paymentIntentId } = req.query;
  if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId required' });
  try {
    const { data: tokenRow } = await supabase.from('tokens').select('token').eq('payment_intent_id', paymentIntentId).maybeSingle();
    if (!tokenRow) return res.status(404).json({ error: 'not found yet' });
    const token = tokenRow.token;
    const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;
    res.json({ giftUrl: `${baseUrl}/gift/redeem?token=${token}` });
  } catch (err) {
    console.error('get-gift-url error:', err);
    res.status(500).json({ error: 'server error' });
  }
});
const EXPIRY_DAYS = 30;
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function notFoundPage() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>ギフトが見つかりません</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:#fff;border-radius:20px;padding:40px 28px;text-align:center;max-width:400px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.1)}.icon{font-size:64px;margin-bottom:16px}h1{font-size:20px;color:#333;margin-bottom:12px}p{color:#888;font-size:14px;line-height:1.7}</style></head><body><div class="card"><div class="icon">🔍</div><h1>ギフトが見つかりません</h1><p>このURLは無効です。<br>送ってくれた方に確認してみてください。</p></div></body></html>`;
}
function alreadyUsedPage(productName) {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>受け取り済み</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:#fff;border-radius:20px;padding:40px 28px;text-align:center;max-width:400px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.1)}.icon{font-size:64px;margin-bottom:16px}h1{font-size:20px;color:#4CAF50;margin-bottom:12px}p{color:#888;font-size:14px;line-height:1.7}</style></head><body><div class="card"><div class="icon">✅</div><h1>受け取り済みです</h1><p>「${esc(productName)}」はすでに受け取られています。<br>このギフトURLは1度しか使用できません。</p></div></body></html>`;
}
function refundedPage() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>返金済み</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:#fff;border-radius:20px;padding:40px 28px;text-align:center;max-width:400px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.1)}.icon{font-size:64px;margin-bottom:16px}h1{font-size:20px;color:#e53935;margin-bottom:12px}p{color:#888;font-size:14px;line-height:1.7}</style></head><body><div class="card"><div class="icon">💴</div><h1>このギフトは返金されました</h1><p>このギフトURLは無効です。<br>ご不明な点はお問い合わせください。</p></div></body></html>`;
}
// 店頭受け取りQRの確認ページ（店員が目視確認するための画面・表示＝使用済み）
function verifyPage(productName, usedAt) {
  const when = usedAt ? new Date(usedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '';
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>受け取り確認</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:#fff;border-radius:20px;padding:40px 28px;text-align:center;max-width:400px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.1)}.icon{font-size:64px;margin-bottom:16px}h1{font-size:22px;color:#4CAF50;margin-bottom:12px}.product{background:#f8fff8;border:1.5px solid #4CAF50;border-radius:12px;padding:16px;margin:16px 0;font-size:17px;font-weight:bold;color:#222}p{color:#888;font-size:13px;line-height:1.7}.when{color:#aaa;font-size:12px;margin-top:8px}</style></head><body><div class="card"><div class="icon">✅</div><h1>受け取り済み</h1><div class="product">${esc(productName)}</div><p>店員さんにこの画面をお見せください。<br>商品をお渡しします。</p>${when ? `<div class="when">受け取り日時: ${esc(when)}</div>` : ''}</div></body></html>`;
}
// GET /gift/redeem
router.get('/gift/redeem', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(404).send(notFoundPage());
  let giftToken = null;
  try {
    const { data: gt } = await supabase.from('tokens').select('*').eq('token', token).maybeSingle();
    giftToken = gt || null;
  } catch (err) {
    console.error('Gift redeem DB error:', err);
  }
  if (!giftToken) return res.status(404).send(notFoundPage());
  if (giftToken.status === 'refunded') return res.send(refundedPage());
  if (giftToken.status === 'used') return res.send(alreadyUsedPage(giftToken.product_name));
  const isExpired = (Date.now() - new Date(giftToken.created_at).getTime()) > EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  const expiryDate = new Date(new Date(giftToken.created_at).getTime() + EXPIRY_DAYS * 24 * 60 * 60 * 1000).toLocaleDateString('ja-JP');
  const isFirstOpen = !giftToken.used_at;
  if (!isExpired && isFirstOpen) {
    const { data: claimed } = await supabase.from('tokens').update({ used_at: new Date().toISOString() }).eq('token', token).is('used_at', null).select('token');
    if (claimed && claimed.length > 0) {
      supabase.from('purchases').update({ claimed_at: new Date().toISOString() }).eq('payment_intent_id', giftToken.payment_intent_id).then(() => {}).catch(console.error);
      lineClient.pushMessage({
        to: giftToken.line_user_id,
        messages: [buildClaimedFlex(giftToken.product_name)],
      }).catch(err => console.error('Claim notification error:', err));
    }
  }
  const productName = giftToken.product_name || 'ギフト券';
  const giftMessage = giftToken.gift_message || '';
  const senderName = giftToken.sender_name || '';
  res.send(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ギフトが届きました</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 24px 16px 40px; background: #f0f2f5; }
    .card { background: #fff; border-radius: 20px; padding: 36px 28px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); text-align: center; }
    .icon { font-size: 72px; margin-bottom: 20px; }
    h1 { color: #00C300; font-size: 22px; font-weight: bold; margin-bottom: 6px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 28px; }
    .product-box { background: #f8fff8; border: 1.5px solid #00C300; border-radius: 12px; padding: 16px; margin-bottom: 20px; text-align: left; }
    .product-label { font-size: 11px; color: #888; margin-bottom: 4px; }
    .product-name { font-size: 17px; font-weight: bold; color: #222; }
    .message-box { background: #fffbf0; border: 1.5px solid #ffc107; border-radius: 12px; padding: 16px; margin-bottom: 20px; text-align: left; }
    .message-label { font-size: 11px; color: #888; margin-bottom: 6px; }
    .message-text { font-size: 15px; color: #444; line-height: 1.7; white-space: pre-wrap; }
    .token-box { background: #f5f5f5; border-radius: 10px; padding: 14px; margin-bottom: 20px; }
    .token-label { font-size: 11px; color: #888; margin-bottom: 6px; }
    .token { font-family: monospace; font-size: 13px; letter-spacing: 1px; color: #444; font-weight: bold; word-break: break-all; }
    .note { color: #aaa; font-size: 12px; line-height: 1.7; }
    .expired-box { background: #fff3cd; border: 1px solid #ffc107; border-radius: 12px; padding: 16px; color: #856404; font-size: 14px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🎁</div>
    <h1>ギフトが届きました！</h1>
    <p class="subtitle">${senderName ? `💌 <strong>${esc(senderName)}</strong>さんからのプレゼントです` : '大切な方からのプレゼントです'}</p>
    <div class="product-box">
      <div class="product-label">ギフト内容</div>
      <div class="product-name">${esc(productName)}</div>
      <div style="font-size:11px; color:${isExpired ? '#e53935' : '#888'}; margin-top:6px;">
        ${isExpired ? '⚠️ 有効期限切れ' : `有効期限: ${expiryDate}まで`}
      </div>
    </div>
    ${giftMessage ? `<div class="message-box"><div class="message-label">💌 メッセージ</div><div class="message-text">${esc(giftMessage)}</div></div>` : ''}
    ${isExpired ? `<div class="expired-box">このギフトの有効期限が切れています。<br>ご不明な点はお問い合わせください。</div>` : `
    <div style="background:#e8f5e9; border:1.5px solid #00C300; border-radius:12px; padding:16px; margin-bottom:20px; text-align:left;">
      <div style="font-size:13px; font-weight:bold; color:#00a000; margin-bottom:6px;">✅ ギフト受け取り完了</div>
      <div style="font-size:14px; color:#444; line-height:1.7;">このギフトは正常に受け取られました。<br>引き換え方法については送ってくれた方にご確認ください。</div>
    </div>
    <div style="margin-top:24px; text-align:center; color:#888; font-size:13px; line-height:1.6;">LINEのトークに戻るには<br>右上の <strong>✕</strong> をタップしてください</div>
    <div style="margin-top:12px; text-align:center; color:#aaa; font-size:12px;">ご不明な点はLINEのトークよりお問い合わせください</div>
    `}
  </div>
  <script></script>
</body>
</html>`);
});
// GET /gift/verify — 店頭受け取りQRの確認ページ（初回スキャンで使用済み確定）
router.get('/gift/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(404).send(notFoundPage());
  const { data: g } = await supabase.from('gifts').select('*').eq('qr_token', token).maybeSingle();
  if (!g) return res.status(404).send(notFoundPage());
  if (g.status === 'refunded') return res.send(refundedPage());
  const items = Array.isArray(g.items) ? g.items : [];
  const item = items.find(i => String(i.id) === String(g.selected_item_id)) || items[0] || {};
  let usedAt = g.used_at;
  if (!usedAt) {
    // ★ atomic: used_at が null の時だけ確定（最初の1スキャンのみ成功）
    const now = new Date().toISOString();
    const { data: claimed } = await supabase.from('gifts')
      .update({ status: 'picked_up', qr_status: 'used', used_at: now })
      .eq('gift_id', g.gift_id).is('used_at', null).select('gift_id');
    if (claimed && claimed.length > 0) usedAt = now;
  }
  res.send(verifyPage(item.name || 'ギフト', usedAt));
});
// ── Admin routes ──────────────────────────────────────────────
// GET /admin/gifts — Giftalk専用管理画面
router.get('/admin/gifts', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const PAGE_SIZE = 50;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '';
  const toDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '';
  let countQuery = supabase.from('gifts').select('status', { count: 'exact' });
  let listQuery = supabase.from('gifts').select('*').order('created_at', { ascending: false });
  if (fromDate) {
    countQuery = countQuery.gte('created_at', `${fromDate}T00:00:00+09:00`);
    listQuery = listQuery.gte('created_at', `${fromDate}T00:00:00+09:00`);
  }
  if (toDate) {
    countQuery = countQuery.lte('created_at', `${toDate}T23:59:59+09:00`);
    listQuery = listQuery.lte('created_at', `${toDate}T23:59:59+09:00`);
  }
  listQuery = listQuery.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  const [{ data: statusRows, count: totalCount }, { data: gifts }] = await Promise.all([countQuery, listQuery]);
  const STATUS_LABEL = { pending: '⏳ 未払い', paid: '💳 支払済（未選択）', selected: '🎯 選択済（QR未発行）', picked_up: '✅ 受取完了' };
  const STATUS_COLOR = { pending: '#f59e0b', paid: '#3b82f6', selected: '#8b5cf6', picked_up: '#22c55e' };
  const counts = { pending: 0, paid: 0, selected: 0, picked_up: 0 };
  (statusRows || []).forEach(g => { if (counts[g.status] !== undefined) counts[g.status]++; });
  const total = totalCount || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  const PENDING_ALERT_DAYS = 2;
  const rows = (gifts || []).map(g => {
    const items = Array.isArray(g.items) ? g.items : [];
    const selected = items.find(i => String(i.id) === String(g.selected_item_id));
    const price = (selected || items[0] || {}).price;
    const color = STATUS_COLOR[g.status] || '#888';
    const label = STATUS_LABEL[g.status] || g.status;
    const date = g.created_at ? new Date(g.created_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const itemsHtml = items.map(i => {
      const isSelected = selected && String(i.id) === String(g.selected_item_id);
      return `<span style="${isSelected ? 'font-weight:bold;color:#00a000;' : 'color:#999;'}">${isSelected ? '✓ ' : ''}${esc(i.name)}</span>`;
    }).join('<br>');
    const returnTo = esc(`/admin/gifts?${(() => { const p = new URLSearchParams(); if (fromDate) p.set('from', fromDate); if (toDate) p.set('to', toDate); p.set('page', String(page)); return p.toString(); })()}`);
    const pickup = g.used_at
      ? `<span style="color:#22c55e;font-weight:bold;">✅ 受取済</span><br><span style="font-size:10px;color:#aaa;">${new Date(g.used_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>`
      : g.qr_token
        ? `<span style="color:#8b5cf6;">📱 QR発行済</span><div style="margin-top:4px;"><form method="POST" action="/admin/gifts/${encodeURIComponent(g.gift_id)}/confirm-pickup" style="display:inline;" onsubmit="return confirm('QRが読めない等の理由で、手動で受取完了にします。よろしいですか？');"><input type="hidden" name="return" value="${returnTo}"><button type="submit" class="action-btn" style="background:#8b5cf6;">手動受取確認</button></form></div>`
        : '<span style="color:#ccc;">-</span>';
    let reservation;
    if (g.status === 'refunded' || g.status === 'picked_up') {
      reservation = '<span style="color:#ccc;">-</span>';
    } else if (g.selected_item_id) {
      const confirmBadge = g.reservation_confirmed_at
        ? `<span style="color:#22c55e;font-weight:bold;">✔確保済</span><br><span style="font-size:10px;color:#aaa;">${new Date(g.reservation_confirmed_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>`
        : '<span style="color:#f59e0b;">未確保</span>';
      const confirmBtn = g.reservation_confirmed_at ? '' : `<form method="POST" action="/admin/gifts/${encodeURIComponent(g.gift_id)}/confirm-reservation" style="display:inline;"><input type="hidden" name="return" value="${returnTo}"><button type="submit" class="action-btn" style="background:#22c55e;">確保確認</button></form>`;
      const releaseBtn = `<form method="POST" action="/admin/gifts/${encodeURIComponent(g.gift_id)}/release-reservation" style="display:inline;" onsubmit="return confirm('確保を解除し、受取人が選び直せる状態に戻します。よろしいですか？');"><input type="hidden" name="return" value="${returnTo}"><button type="submit" class="action-btn" style="background:#e53935;">確保解除</button></form>`;
      reservation = `${confirmBadge}<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap;">${confirmBtn}${releaseBtn}</div>`;
    } else {
      reservation = '<span style="color:#ccc;">-</span>';
    }
    let resend = '<span style="color:#ccc;">-</span>';
    if (g.status !== 'refunded' && g.status !== 'picked_up' && g.line_user_id) {
      resend = `<form method="POST" action="/admin/gifts/${encodeURIComponent(g.gift_id)}/resend-url" style="display:inline;"><input type="hidden" name="return" value="${returnTo}"><button type="submit" class="action-btn" style="background:#3b82f6;">URL再送</button></form>`;
    }
    let rowStyle = '';
    if (g.status !== 'refunded' && g.status !== 'picked_up') {
      const pendingSince = g.selected_at || g.created_at;
      if (pendingSince && (Date.now() - new Date(pendingSince).getTime()) > PENDING_ALERT_DAYS * 24 * 60 * 60 * 1000) {
        rowStyle = ' style="background:#fff8e1;"';
      }
    }
    return `<tr${rowStyle}>
      <td style="font-size:12px;color:#888;white-space:nowrap;">${esc(date)}</td>
      <td style="font-size:11px;font-family:monospace;color:#aaa;">${esc(g.gift_id)}</td>
      <td style="font-weight:bold;">${esc(g.sender_name)}</td>
      <td style="font-size:12px;color:#666;max-width:180px;">${esc(g.occasion_text || '-')}</td>
      <td style="font-size:12px;line-height:1.6;">${itemsHtml || '-'}${items.length > 1 ? `<div style="font-size:10px;color:#aaa;margin-top:2px;">${items.length}択</div>` : ''}</td>
      <td style="font-weight:bold; white-space:nowrap;">${price != null ? '¥' + Number(price).toLocaleString() : '-'}</td>
      <td><span style="background:${color}1a;color:${color};padding:4px 10px;border-radius:12px;font-size:11px;font-weight:bold;white-space:nowrap;">${label}</span></td>
      <td style="font-size:12px;text-align:center;">${pickup}</td>
      <td style="font-size:12px;text-align:center;white-space:nowrap;">${reservation}</td>
      <td style="font-size:12px;text-align:center;white-space:nowrap;">${resend}</td>
    </tr>`;
  }).join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Giftalk管理画面</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f5f6f8;padding:24px;color:#222}
h1{font-size:22px;margin-bottom:4px}
.sub{font-size:13px;color:#888;margin-bottom:24px}
.stats{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}
.stat{background:#fff;border-radius:12px;padding:16px 24px;box-shadow:0 1px 4px rgba(0,0,0,.06);min-width:130px;text-align:center;border-top:3px solid transparent}
.stat-n{font-size:28px;font-weight:bold}
.stat-l{font-size:12px;color:#888;margin-top:2px}
.card{background:#fff;border-radius:12px;padding:8px;box-shadow:0 1px 4px rgba(0,0,0,.06);margin-bottom:20px;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:10px 12px;border-bottom:2px solid #eee;font-size:11px;color:#999;white-space:nowrap;position:sticky;top:0;background:#fff;text-transform:uppercase;letter-spacing:.03em}
td{padding:10px 12px;border-bottom:1px solid #f5f5f5;vertical-align:middle}
tr:hover td{background:#fafbfc}
.nav{margin-bottom:20px}
.nav a{text-decoration:none;color:#3b82f6;font-size:13px;margin-right:16px}
.nav a.active{font-weight:bold;color:#00a000}
.filter-form{display:flex;align-items:center;gap:8px;margin-bottom:20px;flex-wrap:wrap;font-size:13px}
.filter-form input[type=date]{padding:6px 8px;border:1px solid #ddd;border-radius:6px;font-size:13px}
.filter-form button{padding:7px 16px;border:none;border-radius:6px;background:#3b82f6;color:#fff;font-size:13px;cursor:pointer}
.filter-form a.clear{color:#888;text-decoration:none}
.pagination{display:flex;align-items:center;gap:8px;justify-content:center;padding:14px;font-size:13px}
.pagination a, .pagination span{padding:6px 12px;border-radius:6px;text-decoration:none;color:#3b82f6;border:1px solid #eee}
.pagination span.current{background:#3b82f6;color:#fff;border-color:#3b82f6}
.pagination a.disabled{color:#ccc;pointer-events:none;border-color:#f5f5f5}
.action-btn{border:none;border-radius:6px;color:#fff;font-size:11px;padding:5px 8px;cursor:pointer;white-space:nowrap}
</style></head><body>
<div class="nav"><a href="/admin">📊 ダッシュボード</a><a href="/admin/gifts" class="active">🎁 Giftalkギフト</a><a href="/admin/gifts/export.csv">📥 CSV出力（全件）</a></div>
<h1>🎁 Giftalk 管理画面</h1>
<p class="sub">N択ギフトの送受信・受け取り状況を確認できます</p>
<p class="sub" style="margin-top:-20px;"><span style="background:#fff8e1;border:1px solid #ffe082;padding:2px 8px;border-radius:4px;">黄色の行</span> = 選択から${PENDING_ALERT_DAYS}日以上、受け取りが完了していません</p>
<form class="filter-form" method="get">
  <label>期間:</label>
  <input type="date" name="from" value="${esc(fromDate)}">
  〜
  <input type="date" name="to" value="${esc(toDate)}">
  <button type="submit">絞り込む</button>
  ${(fromDate || toDate) ? '<a class="clear" href="/admin/gifts">条件をクリア</a>' : ''}
</form>
<div class="stats">
  <div class="stat" style="border-top-color:#f59e0b"><div class="stat-n" style="color:#f59e0b">${counts.pending}</div><div class="stat-l">⏳ 未払い</div></div>
  <div class="stat" style="border-top-color:#3b82f6"><div class="stat-n" style="color:#3b82f6">${counts.paid}</div><div class="stat-l">💳 支払済（未選択）</div></div>
  <div class="stat" style="border-top-color:#8b5cf6"><div class="stat-n" style="color:#8b5cf6">${counts.selected}</div><div class="stat-l">🎯 選択済（QR未発行）</div></div>
  <div class="stat" style="border-top-color:#22c55e"><div class="stat-n" style="color:#22c55e">${counts.picked_up}</div><div class="stat-l">✅ 受取完了</div></div>
  <div class="stat"><div class="stat-n">${total}</div><div class="stat-l">合計（該当件数）</div></div>
</div>
<div class="card">
  <table>
    <thead><tr>
      <th>日時</th><th>ギフトID</th><th>送り手</th><th>メッセージ</th>
      <th>商品</th><th>金額</th><th>ステータス</th><th>受け取り</th><th>商品確保</th><th>URL再送</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="10" style="text-align:center;color:#aaa;padding:32px;">データなし</td></tr>'}</tbody>
  </table>
  <div class="pagination">
    ${pageLink(page - 1, '← 前へ', page <= 1)}
    <span class="current">${page} / ${totalPages}</span>
    ${pageLink(page + 1, '次へ →', page >= totalPages)}
  </div>
</div>
</body></html>`);
  function pageLink(p, label, disabled) {
    if (disabled) return `<a class="disabled">${label}</a>`;
    const params = new URLSearchParams();
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    params.set('page', String(p));
    return `<a href="/admin/gifts?${params.toString()}">${label}</a>`;
  }
});
router.post('/admin/gifts/:id/confirm-reservation', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const giftId = req.params.id;
  await supabase.from('gifts').update({ reservation_confirmed_at: new Date().toISOString() }).eq('gift_id', giftId);
  res.redirect(req.body.return || '/admin/gifts');
});
router.post('/admin/gifts/:id/release-reservation', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const giftId = req.params.id;
  await supabase.from('gifts').update({
    selected_item_id: null,
    selected_at: null,
    qr_token: null,
    qr_status: 'unused',
    used_at: null,
    fulfillment_method: null,
    status: 'paid',
    reservation_confirmed_at: null,
  }).eq('gift_id', giftId);
  res.redirect(req.body.return || '/admin/gifts');
});
router.post('/admin/gifts/:id/confirm-pickup', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const giftId = req.params.id;
  await supabase.from('gifts').update({ status: 'picked_up', qr_status: 'used', used_at: new Date().toISOString() }).eq('gift_id', giftId);
  res.redirect(req.body.return || '/admin/gifts');
});
router.post('/admin/gifts/:id/resend-url', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const giftId = req.params.id;
  const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;
  try {
    const { data: gift } = await supabase.from('gifts').select('line_user_id').eq('gift_id', giftId).maybeSingle();
    if (gift?.line_user_id) {
      const shareUrl = `${baseUrl}/gift/select.html?gift=${giftId}`;
      await lineClient.pushMessage({
        to: gift.line_user_id,
        messages: [{ type: 'text', text: `🎁 ギフトURLを再送します\n\n受取人にこのURLを送ってください👇\n${shareUrl}` }],
      });
    }
  } catch (err) {
    console.error('resend-url error:', err);
  }
  res.redirect(req.body.return || '/admin/gifts');
});
router.get('/admin/gifts/export.csv', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { data: gifts } = await supabase.from('gifts').select('*').order('created_at', { ascending: false });
  const header = '日時,ギフトID,送り手,シーン,3択商品,選ばれた商品,ステータス,届け先';
  const rows = (gifts || []).map(g => {
    const items = Array.isArray(g.items) ? g.items.map(i => `${i.name}¥${i.price}`).join('|') : '';
    const selected = Array.isArray(g.items) ? (g.items.find(i => i.id === g.selected_item_id) || {}).name || '' : '';
    const addr = g.recipient_address ? JSON.stringify(g.recipient_address).replace(/"/g,'""') : '';
    return [
      g.created_at, g.gift_id, g.sender_name, g.occasion_text || '',
      items, selected, g.status, addr,
    ].map(v => `"${String(v || '').replace(/"/g,'""')}"`).join(',');
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="gifts.csv"');
  res.send('﻿' + [header, ...rows].join('\n'));
});
router.get('/admin', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const [{ data: purchases }, { data: convs }, { count: unclaimedCount }, { data: productListData }, { data: funnelData }, { data: recViewData }, { data: summaries }, { count: unsummarizedCount }] = await Promise.all([
    supabase.from('purchases').select('*').order('timestamp', { ascending: false }).limit(500),
    supabase.from('conversation_logs').select('*').order('timestamp', { ascending: false }).limit(50),
    supabase.from('tokens').select('*', { count: 'exact', head: true }).is('used_at', null).neq('status', 'refunded'),
    supabase.from('products').select('*').order('is_active', { ascending: false }).order('id'),
    supabase.from('funnel_events').select('event_type, user_id, product_id'),
    supabase.from('funnel_events').select('product_id, user_id').eq('event_type', 'rec_view').not('product_id', 'is', null),
    supabase.from('conversation_summaries').select('*').order('id', { ascending: false }).limit(10),
    (async () => {
      const { data: lastSummary } = await supabase.from('conversation_summaries').select('to_log_id').order('id', { ascending: false }).limit(1).maybeSingle();
      let q = supabase.from('conversation_logs').select('*', { count: 'exact', head: true });
      if (lastSummary?.to_log_id) q = q.gt('id', lastSummary.to_log_id);
      return q;
    })(),
  ]);
  // JS aggregation
  const purchaseRows = { rows: (purchases || []).slice(0, 100) };
  const convRows = { rows: convs || [] };
  const summaryRows = { rows: summaries || [] };
  const statsRows = { rows: [{ count: String((purchases || []).length), total: String((purchases || []).reduce((s, p) => s + Number(p.amount), 0)) }] };
  const unclaimedRows = { rows: [{ count: String(unclaimedCount || 0) }] };
  const productListRows = { rows: productListData || [] };
  // Daily sales (last 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentP = (purchases || []).filter(p => new Date(p.timestamp) > sevenDaysAgo);
  const dailyMap = {};
  recentP.forEach(p => {
    const d = new Date(p.timestamp);
    const jstDate = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    const key = `${String(jstDate.getUTCMonth() + 1).padStart(2, '0')}/${String(jstDate.getUTCDate()).padStart(2, '0')}`;
    dailyMap[key] = (dailyMap[key] || 0) + Number(p.amount);
  });
  const dailyRows = { rows: Object.entries(dailyMap).sort(([a], [b]) => a.localeCompare(b)).map(([day, total]) => ({ day, total })) };
  // Product ranking
  const rankMap = {};
  (purchases || []).forEach(p => { rankMap[p.product_name] = (rankMap[p.product_name] || 0) + 1; });
  const rankingRows = { rows: Object.entries(rankMap).sort(([, a], [, b]) => b - a).slice(0, 5).map(([product_name, count]) => ({ product_name, count })) };
  // Funnel events
  const funnelMap = {};
  (funnelData || []).forEach(r => { funnelMap[r.event_type] = (funnelMap[r.event_type] || 0) + 1; });
  const funnelRows = { rows: Object.entries(funnelMap).map(([event_type, count]) => ({ event_type, count })) };
  // AI recommendations
  const recMap = {};
  (recViewData || []).forEach(r => { if (!recMap[r.product_id]) recMap[r.product_id] = new Set(); recMap[r.product_id].add(r.user_id); });
  const buyMap = {};
  (purchases || []).forEach(p => { if (p.product_id) buyMap[p.product_id] = (buyMap[p.product_id] || 0) + 1; });
  const pNameMap = Object.fromEntries((productListData || []).map(p => [p.id, p.name]));
  const recRows = { rows: Object.entries(recMap).filter(([pid]) => pNameMap[pid]).map(([pid, users]) => ({ product_id: pid, name: pNameMap[pid], rec_count: users.size, buy_count: buyMap[pid] || 0 })).sort((a, b) => b.rec_count - a.rec_count).slice(0, 10) };
  // Day of week & hour
  const dowMap = {}, hourMap = {};
  (purchases || []).forEach(p => {
    const d = new Date(p.timestamp);
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    const dow = jst.getUTCDay();
    const hour = jst.getUTCHours();
    dowMap[dow] = (dowMap[dow] || 0) + 1;
    hourMap[hour] = (hourMap[hour] || 0) + 1;
  });
  const dowRows = { rows: Object.entries(dowMap).map(([dow, count]) => ({ dow: parseInt(dow), count })) };
  const hourRows = { rows: Object.entries(hourMap).map(([hour, count]) => ({ hour: parseInt(hour), count })) };
  const importedMsg = req.query.imported ? `✅ ${req.query.imported}件追加、${req.query.skipped}件スキップしました` : '';
  const { count, total } = statsRows.rows[0];
  const fd = {
    liff_open: funnelMap['liff_open'] || 0,
    product_select: funnelMap['product_select'] || 0,
    payment_init: funnelMap['payment_init'] || 0,
    payment_complete: funnelMap['payment_complete'] || 0,
  };
  const recData = recRows.rows;
  res.send(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>管理画面</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #f5f5f5; padding: 24px; }
    h1 { font-size: 22px; color: #222; margin-bottom: 16px; }
    h2 { font-size: 14px; color: #555; margin-bottom: 10px; }
    .section { margin-bottom: 28px; }
    .topnav { position: sticky; top: 0; z-index: 20; background: #f5f5f5; display: flex; gap: 18px; flex-wrap: wrap; padding: 10px 0; margin-bottom: 20px; border-bottom: 1px solid #e3e3e3; }
    .topnav a { color: #555; text-decoration: none; font-size: 13px; font-weight: bold; padding: 4px 0; }
    .topnav a:hover { color: #00C300; }
    .group-title { font-size: 18px; font-weight: bold; color: #222; margin: 36px 0 16px; padding-bottom: 8px; border-bottom: 2px solid #00C300; scroll-margin-top: 56px; }
    .group-title:first-of-type { margin-top: 0; }
    .stats { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 28px; }
    .stat-card { background: #fff; border-radius: 12px; padding: 18px 24px; box-shadow: 0 1px 4px rgba(0,0,0,0.1); min-width: 130px; }
    .stat-card .label { font-size: 12px; color: #888; margin-bottom: 5px; }
    .stat-card .value { font-size: 26px; font-weight: bold; color: #00C300; }
    .stat-card .value.warn { color: #e53935; }
    .stat-card .value.blue { color: #1976d2; }
    .chart-card { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.1); }
    .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 28px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.1); }
    th { background: #f0f0f0; padding: 10px 12px; text-align: left; font-size: 12px; color: #555; }
    td { padding: 10px 12px; font-size: 13px; border-top: 1px solid #f0f0f0; color: #333; }
    tr:hover td { background: #fafafa; }
    .badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: bold; display: inline-block; }
    .badge-ok { background: #e8f5e9; color: #2e7d32; }
    .badge-warn { background: #fff3e0; color: #e65100; }
    .badge-ref { background: #fce4ec; color: #c62828; }
    .uid { font-family: monospace; font-size: 11px; color: #aaa; }
    .btn-sm { font-size: 12px; padding: 4px 10px; border: 1px solid #ddd; border-radius: 6px; background: #fff; cursor: pointer; }
    .btn-danger { border-color: #e53935; color: #e53935; }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .form-grid input { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 6px; font-size: 13px; }
    .form-grid label { font-size: 12px; color: #888; display: block; margin-bottom: 4px; }
  </style>
</head>
<body>
  <h1>管理画面</h1>
  ${importedMsg ? `<div style="background:#e8f5e9; border:1px solid #a5d6a7; border-radius:8px; padding:12px 16px; margin-bottom:16px; color:#2e7d32; font-size:13px;">${importedMsg}</div>` : ''}
  <div class="stats">
    <div class="stat-card"><div class="label">総購入数</div><div class="value">${count}件</div></div>
    <div class="stat-card"><div class="label">総売上</div><div class="value">¥${Number(total).toLocaleString()}</div></div>
    <div class="stat-card"><div class="label">未受け取りギフト</div><div class="value ${unclaimedCount > 0 ? 'warn' : ''}">${unclaimedCount}件</div></div>
    <div class="stat-card"><div class="label">会話ログ数</div><div class="value blue">${convs.length}件</div></div>
  </div>
  <div class="section">
    <h2>📈 直近7日間の売上</h2>
    <div class="chart-card"><canvas id="salesChart" height="90"></canvas></div>
  </div>
  <div class="chart-grid">
    <div><h2>🏆 商品別売上 TOP5</h2><div class="chart-card"><canvas id="rankingChart" height="220"></canvas></div></div>
    <div>
      <h2>🔽 購入ファネル</h2>
      <div class="chart-card" style="padding:24px 16px;">
        ${(() => {
          const steps = [
            { label: 'LIFF開封', val: fd.liff_open, icon: '📱' },
            { label: '商品選択', val: fd.product_select, icon: '🛍' },
            { label: '支払い開始', val: fd.payment_init, icon: '💳' },
            { label: '支払い完了', val: fd.payment_complete, icon: '✅' },
          ];
          return steps.map((s, i) => {
            const next = steps[i + 1];
            const rate = next && s.val > 0 ? Math.round(next.val / s.val * 100) : null;
            const rateColor = rate === null ? '' : rate >= 50 ? '#00C300' : rate >= 20 ? '#f57c00' : '#e53935';
            return `<div style="display:flex; align-items:center;">
              <div style="flex:1; background:#f8f9fa; border-radius:10px; padding:12px 14px; display:flex; align-items:center; gap:10px;">
                <span style="font-size:20px;">${s.icon}</span>
                <div><div style="font-size:11px; color:#888;">${s.label}</div><div style="font-size:22px; font-weight:bold; color:#222;">${s.val.toLocaleString()}<span style="font-size:12px; color:#aaa; margin-left:2px;">件</span></div></div>
              </div>
              ${rate !== null ? `<div style="width:60px; text-align:center; flex-shrink:0;"><div style="font-size:13px; font-weight:bold; color:${rateColor};">${rate}%</div><div style="color:#bbb; font-size:16px;">↓</div></div>` : ''}
            </div>`;
          }).join('');
        })()}
      </div>
    </div>
  </div>
  <div class="chart-grid">
    <div><h2>📅 曜日別購入数</h2><div class="chart-card"><canvas id="dowChart" height="220"></canvas></div></div>
    <div><h2>🕐 時間帯別購入数</h2><div class="chart-card"><canvas id="hourChart" height="220"></canvas></div></div>
  </div>
  <div class="section">
    <h2>🤖 AI推薦 → 購入転換率</h2>
    <p style="font-size:12px; color:#888; margin-bottom:10px;">AIがチャットで紹介した回数に対して実際に購入された割合</p>
    <table>
      <thead><tr><th>商品名</th><th>AIが紹介した回数</th><th>購入された回数</th><th>転換率</th></tr></thead>
      <tbody>
        ${recData.length === 0
          ? '<tr><td colspan="4" style="text-align:center;color:#aaa;padding:24px">データなし</td></tr>'
          : recData.map(r => {
              const conv = r.rec_count > 0 ? (Number(r.buy_count) / Number(r.rec_count) * 100).toFixed(1) : '0.0';
              const barWidth = Math.min(Number(conv), 100);
              return `<tr><td>${esc(r.name)}</td><td style="text-align:center;">${r.rec_count}回</td><td style="text-align:center;">${r.buy_count}回</td><td style="min-width:120px;"><div style="display:flex; align-items:center; gap:8px;"><div style="flex:1; background:#f0f0f0; border-radius:4px; height:8px; overflow:hidden;"><div style="width:${barWidth}%; height:100%; background:${Number(conv) >= 10 ? '#00C300' : Number(conv) >= 3 ? '#f57c00' : '#e0e0e0'}; border-radius:4px;"></div></div><span style="font-weight:bold; color:${Number(conv) >= 10 ? '#00C300' : Number(conv) >= 3 ? '#f57c00' : '#999'}; min-width:36px;">${conv}%</span></div></td></tr>`;
            }).join('')}
      </tbody>
    </table>
  </div>
  <div class="section">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
      <h2>📦 商品管理</h2>
      <div style="display:flex; gap:8px;">
        <button class="btn-sm" onclick="var f=document.getElementById('import-pf');f.style.display=f.style.display==='none'?'block':'none'">📥 CSV一括追加</button>
        <button class="btn-sm" onclick="var f=document.getElementById('add-pf');f.style.display=f.style.display==='none'?'block':'none'">＋ 商品を追加</button>
      </div>
    </div>
    <div id="import-pf" style="display:none; background:#fff; border-radius:12px; padding:20px; margin-bottom:12px; box-shadow:0 1px 4px rgba(0,0,0,0.1);">
      <p style="font-size:12px; color:#888; margin-bottom:8px;">1行1商品でCSVを貼り付けてください。形式: <code>商品ID,商品名,金額(円),カテゴリ,説明</code></p>
      <form method="POST" action="/admin/import/products">
        <textarea name="csv" rows="8" style="width:100%; padding:10px; border:1px solid #ddd; border-radius:6px; font-size:12px; font-family:monospace;" placeholder="gift_100,商品名,1000,カテゴリ,説明"></textarea>
        <button type="submit" style="margin-top:8px; background:#1976d2; color:#fff; border:none; border-radius:8px; padding:8px 20px; font-size:13px; cursor:pointer;">インポート実行</button>
      </form>
    </div>
    <div id="add-pf" style="display:none; background:#fff; border-radius:12px; padding:20px; margin-bottom:12px; box-shadow:0 1px 4px rgba(0,0,0,0.1);">
      <form method="POST" action="/admin/products">
        <div class="form-grid">
          <div><label>商品ID（例: gift_052）</label><input name="id" required placeholder="gift_052"></div>
          <div><label>商品名</label><input name="name" required placeholder="スターバックスカード 500円"></div>
          <div><label>金額（円）</label><input name="amount" type="number" required placeholder="500"></div>
          <div><label>カテゴリ</label><input name="category" required placeholder="カフェ"></div>
          <div style="grid-column:1/-1"><label>説明文</label><input name="description" placeholder="商品の説明を入力..."></div>
          <div style="grid-column:1/-1"><button type="submit" style="background:#00C300; color:#fff; border:none; border-radius:8px; padding:10px 24px; font-size:14px; cursor:pointer;">追加する</button></div>
        </div>
      </form>
    </div>
    <table>
      <thead><tr><th>ID</th><th>商品名</th><th>金額</th><th>カテゴリ</th><th>状態</th><th>操作</th></tr></thead>
      <tbody>
        ${productListRows.rows.map(p => `<tr>
          <td class="uid">${esc(p.id)}</td><td>${esc(p.name)}</td><td>¥${Number(p.amount).toLocaleString()}</td><td>${esc(p.category)}</td>
          <td><span class="badge ${p.is_active ? 'badge-ok' : ''}" style="${p.is_active ? '' : 'background:#eee;color:#999;'}">${p.is_active ? '有効' : '無効'}</span></td>
          <td><form method="POST" action="/admin/products/${esc(p.id)}/toggle" style="display:inline;"><button type="submit" class="btn-sm">${p.is_active ? '無効にする' : '有効にする'}</button></form></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
  <div class="section">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
      <h2>購入履歴</h2>
      <a href="/admin/export/purchases.csv" style="background:#1976d2; color:#fff; text-decoration:none; padding:8px 16px; border-radius:8px; font-size:13px;">📥 CSVダウンロード</a>
    </div>
    <table>
      <thead><tr><th>日時</th><th>ユーザーID</th><th>商品</th><th>金額</th><th>ステータス</th><th>操作</th></tr></thead>
      <tbody>
        ${purchases.length === 0
          ? '<tr><td colspan="6" style="text-align:center;color:#aaa;padding:24px">まだ購入がありません</td></tr>'
          : purchases.map(p => `<tr>
              <td>${new Date(p.timestamp).toLocaleString('ja-JP')}</td>
              <td class="uid">${esc(p.user_id.slice(0, 12))}...</td>
              <td>${esc(p.product_name)}</td>
              <td>¥${Number(p.amount).toLocaleString()}</td>
              <td>${p.refunded_at ? '<span class="badge badge-ref">返金済み</span>' : p.claimed_at ? '<span class="badge badge-ok">受け取り済み</span>' : '<span class="badge badge-warn">未受け取り</span>'}</td>
              <td>${!p.refunded_at ? `<form method="POST" action="/admin/refund" style="display:inline;" onsubmit="return confirm('返金しますか？この操作は取り消せません。')"><input type="hidden" name="purchaseId" value="${p.id}"><input type="hidden" name="paymentIntentId" value="${esc(p.payment_intent_id)}"><input type="hidden" name="userId" value="${esc(p.user_id)}"><input type="hidden" name="productName" value="${esc(p.product_name)}"><button type="submit" class="btn-sm btn-danger">返金</button></form>` : '-'}</td>
            </tr>`).join('')}
      </tbody>
    </table>
  </div>
  <div class="section">
    <h2>🤖 AI会話の要約（顧客ニーズ分析）</h2>
    <div style="background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.1);">
      <form method="POST" action="/admin/summarize-conversations" style="margin-bottom:14px;">
        <button type="submit" class="btn-sm" style="background:#7b1fa2;color:#fff;border:none;padding:8px 18px;border-radius:6px;cursor:pointer;font-size:13px;" ${(unsummarizedCount || 0) === 0 ? 'disabled' : ''}>
          要約を作成（未要約 ${unsummarizedCount || 0}件）
        </button>
      </form>
      ${summaryRows.rows.length === 0
        ? '<p style="color:#aaa;font-size:13px;">まだ要約がありません。会話が溜まったら「要約を作成」を押してください。</p>'
        : summaryRows.rows.map(s => `
          <div style="border-top:1px solid #f0f0f0;padding:12px 0;">
            <div style="font-size:11px;color:#aaa;margin-bottom:6px;">${new Date(s.created_at).toLocaleString('ja-JP')}（${s.log_count}件分）</div>
            <div style="font-size:13px;line-height:1.8;white-space:pre-wrap;">${esc(s.summary)}</div>
          </div>`).join('')}
    </div>
  </div>
  <div class="section">
    <h2>最新の会話ログ</h2>
    <table>
      <thead><tr><th>日時</th><th>ユーザーID</th><th>ユーザー発言</th><th>AI返答</th><th>AI推薦</th></tr></thead>
      <tbody>
        ${convs.length === 0
          ? '<tr><td colspan="5" style="text-align:center;color:#aaa;padding:24px">まだ会話がありません</td></tr>'
          : convs.map(c => {
            const isQR = (c.user_message || '').startsWith('[QR] ');
            const displayMsg = isQR ? c.user_message.slice(5) : (c.user_message || '');
            const sourceLabel = c.source === 'liff_chat' ? 'サイト内' : 'LINEトーク';
            const badge = isQR
              ? '<span style="background:#06C755;color:#fff;border-radius:3px;padding:1px 6px;font-size:10px;font-weight:bold;margin-right:4px;vertical-align:middle">QR</span>'
              : `<span style="background:#888;color:#fff;border-radius:3px;padding:1px 4px;font-size:10px;font-weight:bold;margin-right:4px;vertical-align:middle">${sourceLabel}</span>`;
            const recCount = Array.isArray(c.recommendations) ? c.recommendations.length : 0;
            return `<tr><td>${new Date(c.timestamp).toLocaleString('ja-JP')}</td><td class="uid">${esc((c.user_id || '').slice(0, 12))}...</td><td>${badge}${esc(displayMsg)}</td><td>${esc((c.ai_response || '').slice(0, 80))}${(c.ai_response || '').length > 80 ? '…' : ''}</td><td style="text-align:center;">${recCount > 0 ? `${recCount}件` : '-'}</td></tr>`;
          }).join('')}
      </tbody>
    </table>
  </div>
  <script>
    const salesLabels = ${JSON.stringify(dailyRows.rows.map(r => r.day))};
    const salesData = ${JSON.stringify(dailyRows.rows.map(r => Number(r.total)))};
    const rankLabels = ${JSON.stringify(rankingRows.rows.map(r => r.product_name.length > 14 ? r.product_name.slice(0, 14) + '…' : r.product_name))};
    const rankData = ${JSON.stringify(rankingRows.rows.map(r => Number(r.count)))};
    new Chart(document.getElementById('salesChart'), { type: 'bar', data: { labels: salesLabels.length ? salesLabels : ['データなし'], datasets: [{ label: '売上（円）', data: salesLabels.length ? salesData : [0], backgroundColor: '#00C300', borderRadius: 4, maxBarThickness: 64 }] }, options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } } });
    new Chart(document.getElementById('rankingChart'), { type: 'bar', data: { labels: rankLabels.length ? rankLabels : ['データなし'], datasets: [{ data: rankLabels.length ? rankData : [0], backgroundColor: '#00C300', borderRadius: 4, maxBarThickness: 28 }] }, options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } } } } });
    const dowLabels = ['日', '月', '火', '水', '木', '金', '土'];
    const dowRaw = ${JSON.stringify(dowRows.rows)};
    const dowData = dowLabels.map((_, i) => { const r = dowRaw.find(x => x.dow === i); return r ? Number(r.count) : 0; });
    new Chart(document.getElementById('dowChart'), { type: 'bar', data: { labels: dowLabels, datasets: [{ data: dowData, backgroundColor: '#1976d2', borderRadius: 4 }] }, options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } } });
    const hourRaw = ${JSON.stringify(hourRows.rows)};
    const hourLabels = Array.from({ length: 24 }, (_, i) => i + '時');
    const hourData = Array.from({ length: 24 }, (_, i) => { const r = hourRaw.find(x => x.hour === i); return r ? Number(r.count) : 0; });
    new Chart(document.getElementById('hourChart'), { type: 'bar', data: { labels: hourLabels, datasets: [{ data: hourData, backgroundColor: '#7b1fa2', borderRadius: 4 }] }, options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } } });
  </script>
</body>
</html>`);
});
// POST /admin/summarize-conversations — 未要約の会話ログをAIでまとめて要約
router.post('/admin/summarize-conversations', async (req, res) => {
  if (!adminAuth(req, res)) return;
  try {
    const { data: lastSummary } = await supabase.from('conversation_summaries').select('to_log_id').order('id', { ascending: false }).limit(1).maybeSingle();
    let q = supabase.from('conversation_logs').select('*').order('id', { ascending: true }).limit(20);
    if (lastSummary?.to_log_id) q = q.gt('id', lastSummary.to_log_id);
    const { data: logs } = await q;
    if (!logs || logs.length === 0) {
      return res.redirect('/admin#summary');
    }
    const transcript = logs.map(l => `[${new Date(l.timestamp).toLocaleString('ja-JP')}]\nお客様: ${l.user_message}\nAI: ${l.ai_response}${Array.isArray(l.recommendations) && l.recommendations.length ? `\n（提案商品: ${l.recommendations.join(', ')}）` : ''}`).join('\n\n');
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `以下は実店舗のギフト相談AIとお客様との会話ログです（${logs.length}件）。\n実証実験の分析担当者向けに、以下の観点で日本語で簡潔に要約してください。\n\n1. よくあるシーン・贈る相手・予算帯の傾向\n2. お客様が困っている点・要望・不満（あれば）\n3. AIがうまく提案できなかった/答えられなかったケース\n4. その他、商品ラインナップや接客の改善につながりそうな気づき\n\n箇条書きで、各項目2〜4行程度にまとめてください。マークダウンの見出し記号（#など）は使わず、「1.」「2.」のような番号付き箇条書きで書いてください。\n\n--- 会話ログ ---\n${transcript}`;
    const result = await model.generateContent(prompt);
    const summary = result.response.text().trim();
    await supabase.from('conversation_summaries').insert({
      log_count: logs.length,
      from_log_id: logs[0].id,
      to_log_id: logs[logs.length - 1].id,
      summary,
    });
    res.redirect('/admin#summary');
  } catch (err) {
    console.error('summarize-conversations error:', err);
    res.redirect('/admin#summary');
  }
});
// POST /admin/refund
router.post('/admin/refund', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const { purchaseId, paymentIntentId, userId, productName } = req.body;
  try {
    await stripe.refunds.create({ payment_intent: paymentIntentId });
    await supabase.from('purchases').update({ refunded_at: new Date().toISOString() }).eq('id', purchaseId);
    await supabase.from('tokens').update({ status: 'refunded' }).eq('payment_intent_id', paymentIntentId);
    await supabase.from('gifts').update({ status: 'refunded' }).eq('stripe_payment_intent_id', paymentIntentId);
    lineClient.pushMessage({
      to: userId,
      messages: [{ type: 'text', text: `💴 「${productName}」の返金が完了しました。数日以内にご返金されます。` }],
    }).catch(console.error);
    res.redirect('/admin');
  } catch (err) {
    console.error('Refund error:', err);
    res.status(500).send('返金エラー: ' + err.message);
  }
});
// GET /admin/export/purchases.csv
router.get('/admin/export/purchases.csv', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { data: allPurchases } = await supabase.from('purchases').select('*').order('timestamp', { ascending: false });
  const header = '日時,ユーザーID,商品名,金額,受け取り状況,返金状況';
  const lines = (allPurchases || []).map(p => [
    new Date(p.timestamp).toLocaleString('ja-JP'),
    p.user_id,
    `"${(p.product_name || '').replace(/"/g, '""')}"`,
    p.amount,
    p.claimed_at ? '受け取り済み' : '未受け取り',
    p.refunded_at ? '返金済み' : '-',
  ].join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="purchases.csv"');
  res.send('﻿' + [header, ...lines].join('\n'));
});
// POST /admin/products/:id/toggle
router.post('/admin/products/:id/toggle', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const productId = req.params.id;
  if (!productId) return res.status(400).send('商品IDが必要です');
  const { data: cur } = await supabase.from('products').select('is_active').eq('id', productId).single();
  await supabase.from('products').update({ is_active: !cur?.is_active }).eq('id', productId);
  invalidateProductsCache();
  res.redirect('/admin');
});
// POST /admin/products
router.post('/admin/products', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { id, name, amount, category, description } = req.body;
  if (!id || !name || !amount || !category) return res.status(400).send('必須項目が不足しています');
  try {
    await supabase.from('products').insert({ id: id.trim(), name: name.trim(), amount: Number(amount), currency: 'jpy', category: category.trim(), description: (description || '').trim() });
    invalidateProductsCache();
    res.redirect('/admin');
  } catch (err) {
    console.error('Product add error:', err);
    res.status(500).send('追加エラー: ' + err.message);
  }
});
// POST /admin/import/products
router.post('/admin/import/products', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { csv } = req.body;
  if (!csv) return res.redirect('/admin');
  const lines = csv.trim().split('\n').filter(l => l.trim() && !l.startsWith('#'));
  let inserted = 0, skipped = 0;
  for (const line of lines) {
    const parts = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    const [id, name, amount, category, description] = parts;
    if (!id || !name || !amount || !category) { skipped++; continue; }
    try {
      const { data: ins, error: insErr } = await supabase.from('products').insert({ id, name, amount: Number(amount), currency: 'jpy', category, description: description || '' }).select();
      if (!insErr && ins && ins.length > 0) inserted++; else skipped++;
    } catch { skipped++; }
  }
  invalidateProductsCache();
  res.redirect(`/admin?imported=${inserted}&skipped=${skipped}`);
});
app.use('/api', router);
app.use('/', router);
module.exports = app;