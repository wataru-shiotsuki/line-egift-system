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
const path = require('path');
const QRCode = require('qrcode');
const { notifyStaff, notifyCustomer } = require('../lib/mailer');
const { createRecipientToken, hashRecipientToken, recipientTokenFromRequest } = require('../lib/recipient-token');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const router = express.Router();

router.get('/gift/select.html', (req, res) => res.sendFile(path.join(__dirname, '../public/gift/select.html')));


const ALLOWED_ORIGIN = process.env.BASE_URL;
const giftalkCors = cors({ origin: ALLOWED_ORIGIN });
['/create-payment-intent', '/gift-data', '/gift-select', '/gift-address', '/gift-receive', '/ai-chat', '/gift-prediction'].forEach(p => {
  router.options(p, giftalkCors);
  router.use(p, giftalkCors);
});


router.get('/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY, liffId: process.env.LIFF_ID });
});


router.get('/products', async (req, res) => {
  const allProducts = await getActiveProducts();
  const list = Object.entries(allProducts).map(([id, p]) => ({
    id, name: p.name, amount: p.amount, description: p.description, category: p.category,
  }));
  res.json(list);
});


router.get('/g/:giftId', async (req, res) => {
  const { giftId } = req.params;
  const tokenHash = hashRecipientToken(req.query.token);
  if (!tokenHash) return res.status(404).send('Gift not found');
  const baseUrl = process.env.BASE_URL;
  const { data: gift } = await supabase.from('gifts').select('gift_id, sender_name, occasion_text, ogp_design_variant').eq('gift_id', giftId).eq('recipient_token_hash', tokenHash).maybeSingle();
  if (!gift) return res.status(404).send('Gift not found');

  const variant = gift?.ogp_design_variant || 'simple';
  const ogpImage = `${baseUrl}/ogp-images/${variant}.png`;
  const title = gift ? `🎁 ${gift.sender_name || ''}さんからギフトが届いています` : '🎁 ギフトが届いています';
  const description = gift?.occasion_text
    ? gift.occasion_text.slice(0, 60) + (gift.occasion_text.length > 60 ? '...' : '')
    : 'あなただけへのギフトです。開いて受け取ってください。';
  const redirectUrl = `${baseUrl}/gift/select.html?gift=${encodeURIComponent(giftId)}#token=${encodeURIComponent(req.query.token)}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:image" content="${ogpImage}" />
<meta property="og:url" content="${baseUrl}/g/${encodeURIComponent(giftId)}?token=${encodeURIComponent(req.query.token)}" />
<meta property="og:type" content="website" />
<meta http-equiv="refresh" content="0;url=${redirectUrl}" />
<title>${esc(title)}</title>
</head>
<body>
<p>リダイレクト中...<br><a href="${redirectUrl}">こちら</a>をタップしてください</p>
</body>
</html>`);
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
提案するときは必ず【商品リストに記載されている正確な商品名】をそのまま使ってください。
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
  const { productId, lineUserId, giftMessage, giftType, items, senderName, occasionText, presentationStyle, payload } = req.body;


  if (giftType === 'giftalk') {
    if (!Array.isArray(items) || items.length < 1) {
      return res.status(400).json({ error: 'items は1件以上必要です' });
    }
    try {

      const allProducts = await getActiveProducts();
      for (const i of items) {
        const catalogProduct = allProducts[i.id];
        if (!catalogProduct) return res.status(400).json({ error: '無効な商品が含まれています' });
        if (Number(i.price) !== Number(catalogProduct.amount)) {
          return res.status(400).json({ error: '商品価格が一致しません' });
        }
      }
      const maxPrice = Math.max(...items.map(i => Number(i.price) || 0));
      if (maxPrice <= 0) return res.status(400).json({ error: '商品価格が不正です' });
      if (!items.every(i => Number(i.price) === maxPrice)) {
        return res.status(400).json({ error: '選択できるのは同じ価格の商品のみです' });
      }
      const giftId = 'GT-' + Date.now().toString(36).toUpperCase() +
                     Math.random().toString(36).slice(2, 5).toUpperCase();
      const recipientToken = createRecipientToken();

      const itemsWithId = items.map((it, i) => ({ ...it, id: String(it.id != null ? it.id : i) }));
      const ogp_design_variant = Math.random() < 0.5 ? 'simple' : 'fancy';
      const comment_variant = Math.random() < 0.5 ? 'none' : 'ai_generated';
      const { error: giftInsertError } = await supabase.from('gifts').insert({
        gift_id: giftId,
        recipient_token_hash: hashRecipientToken(recipientToken),
        sender_name: String(senderName || '').slice(0, 20) || '名無し',
        occasion_text: String(occasionText || '').slice(0, 300),
        items: itemsWithId,
        payload: payload || null,
        presentation_style: ['celebrate','heartfelt','gratitude','casual'].includes(presentationStyle)
          ? presentationStyle : 'celebrate',
        line_user_id: lineUserId || null,
        status: 'pending',
        ogp_design_variant,
        comment_variant,
      });
      if (giftInsertError) throw giftInsertError;
      const paymentIntent = await stripe.paymentIntents.create({
        amount: maxPrice,
        currency: 'jpy',
        automatic_payment_methods: { enabled: true },
        metadata: { giftType: 'giftalk', giftId, lineUserId: lineUserId || '' },
      });
      return res.json({ clientSecret: paymentIntent.client_secret, giftId, recipientToken });
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
      automatic_payment_methods: { enabled: true },
      metadata: { lineUserId, productId, giftMessage: (giftMessage || '').slice(0, 500) },
    });
    supabase.from('funnel_events').insert({ user_id: lineUserId, event_type: 'payment_init', product_id: productId }).then(() => {}).catch(console.error);
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('PaymentIntent error:', err);
    res.status(500).json({ error: '決済の準備に失敗しました。時間をおいて再度お試しください。' });
  }
});


router.post('/gift-prediction', async (req, res) => {
  const { giftId, itemId } = req.body;
  if (!giftId || !itemId) return res.status(400).json({ ok: false });
  const tokenHash = recipientTokenFromRequest(req);
  if (!tokenHash) return res.status(403).json({ ok: false, error: 'gift token required' });
  const { data, error } = await supabase.from('gifts').update({ sender_prediction: String(itemId) })
    .eq('gift_id', giftId).eq('recipient_token_hash', tokenHash).select('gift_id');
  if (error || !data?.length) return res.status(404).json({ ok: false, error: 'Gift not found' });
  res.json({ ok: true });
});


router.get('/gift-data', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  const tokenHash = recipientTokenFromRequest(req);
  if (!tokenHash) return res.status(403).json({ ok: false, error: 'recipient token required' });
  const { data, error } = await supabase.from('gifts')
    .select('gift_id, sender_name, occasion_text, items, status, selected_item_id, fulfillment_method, ogp_design_variant, comment_variant, ai_share_comment, sender_prediction, change_requested_at, change_request_declined_at')
    .eq('gift_id', id).eq('recipient_token_hash', tokenHash).maybeSingle();
  if (error || !data) return res.status(404).json({ ok: false, error: 'Gift not found' });
  const { items, sender_prediction, ...gift } = data;
  gift.has_sender_prediction = Boolean(sender_prediction);
  gift.items = Array.isArray(items) ? items.map(({ id, name, description }) => ({ id, name, description })) : [];
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, gift });
});


router.post('/gift-select', async (req, res) => {
  const { giftId, selectedItemId, method } = req.body;
  if (!giftId || !selectedItemId) return res.status(400).json({ ok: false, error: 'giftId and selectedItemId required' });
  const tokenHash = recipientTokenFromRequest(req);
  if (!tokenHash) return res.status(403).json({ ok: false, error: 'recipient token required' });
  const { data: existing } = await supabase.from('gifts').select('selected_item_id, status, items, qr_token, fulfillment_method').eq('gift_id', giftId).eq('recipient_token_hash', tokenHash).maybeSingle();
  if (!existing) return res.status(404).json({ ok: false, error: 'Gift not found' });
  if (existing.status === 'refunded') return res.status(403).json({ ok: false, error: 'refunded' });
  if (!['paid', 'selected'].includes(existing.status)) return res.status(403).json({ ok: false, error: 'not available' });

  if (existing.qr_token) return res.status(409).json({ ok: false, error: 'already_pickup' });
  if (existing.fulfillment_method === 'shipping' && existing.status === 'completed') return res.status(409).json({ ok: false, error: 'already_shipping' });
  const validItems = Array.isArray(existing.items) ? existing.items : [];
  if (!validItems.some(i => String(i.id) === String(selectedItemId))) {
    return res.status(400).json({ ok: false, error: 'Invalid item' });
  }

  const update = { selected_item_id: String(selectedItemId).slice(0, 64), selected_at: new Date().toISOString(), status: 'selected' };
  update.fulfillment_method = method === 'pickup' ? 'pickup' : 'shipping';
  const { data: updated, error } = await supabase.from('gifts').update(update)
    .eq('gift_id', giftId).eq('recipient_token_hash', tokenHash).in('status', ['paid', 'selected']).is('qr_token', null).select('gift_id');
  if (error) return res.status(500).json({ ok: false, error: 'update failed' });
  if (!updated?.length) return res.status(409).json({ ok: false, error: 'already completed' });
  res.json({ ok: true });
});


router.post('/gift-address', async (req, res) => {
  const { giftId, address } = req.body;
  if (!giftId) return res.status(400).json({ ok: false, error: 'giftId required' });
  const tokenHash = recipientTokenFromRequest(req);
  if (!tokenHash) return res.status(403).json({ ok: false, error: 'recipient token required' });
  if (typeof address !== 'string' || !address.trim() || address.length > 500) return res.status(400).json({ ok: false, error: 'valid address required' });
  const { data: gift } = await supabase.from('gifts').select('gift_id, status, qr_token, fulfillment_method, items, selected_item_id, line_user_id').eq('gift_id', giftId).eq('recipient_token_hash', tokenHash).maybeSingle();
  if (!gift) return res.status(404).json({ ok: false, error: 'Gift not found' });
  if (gift.status !== 'selected' || gift.fulfillment_method !== 'shipping' || !gift.selected_item_id) return res.status(409).json({ ok: false, error: 'select a shipping item first' });
  if (gift.status === 'refunded') return res.status(403).json({ ok: false, error: 'refunded' });

  if (gift.qr_token) return res.status(409).json({ ok: false, error: 'already_pickup' });
  if (gift.fulfillment_method === 'shipping' && gift.status === 'completed') return res.status(409).json({ ok: false, error: 'already_shipping' });
  const { data: completed, error } = await supabase.from('gifts')
    .update({ recipient_address: address.trim(), status: 'completed', fulfillment_method: 'shipping' })
    .eq('gift_id', giftId).eq('recipient_token_hash', tokenHash).eq('status', 'selected').is('qr_token', null)
    .select('gift_id');
  if (error) return res.status(500).json({ ok: false, error: 'update failed' });
  if (!completed?.length) return res.status(409).json({ ok: false, error: 'already completed' });
  const items = Array.isArray(gift.items) ? gift.items : [];
  const item = items.find(i => String(i.id) === String(gift.selected_item_id)) || items[0] || {};
  notifyStaff({
    productName: item.name || 'ギフト',
    orderedAt: new Date().toISOString(),
    giftToken: gift.gift_id,
    lineUserId: gift.line_user_id,
    method: '配送（住所入力）',
    address: address.trim(),
  }).catch(err => console.error('notifyStaff error:', err));
  res.json({ ok: true });
});


router.post('/gift-change-request', async (req, res) => {
  const { giftId, note, contact } = req.body;
  if (!giftId) return res.status(400).json({ ok: false, error: 'giftId required' });
  const tokenHash = recipientTokenFromRequest(req);
  if (!tokenHash) return res.status(403).json({ ok: false, error: 'recipient token required' });
  const { data: gift } = await supabase.from('gifts').select('gift_id, status, items, selected_item_id, line_user_id').eq('gift_id', giftId).eq('recipient_token_hash', tokenHash).maybeSingle();
  if (!gift) return res.status(404).json({ ok: false, error: 'Gift not found' });
  if (gift.status === 'refunded') return res.status(403).json({ ok: false, error: 'refunded' });
  const contactEmail = (contact || '').trim().slice(0, 200);
  await supabase.from('gifts')
    .update({
      change_requested_at: new Date().toISOString(),
      change_request_note: (note || '').slice(0, 500) || null,
      change_request_contact: contactEmail || null,
    })
    .eq('gift_id', giftId).eq('recipient_token_hash', tokenHash);
  const items = Array.isArray(gift.items) ? gift.items : [];
  const item = items.find(i => String(i.id) === String(gift.selected_item_id)) || items[0] || {};
  notifyStaff({
    productName: item.name || 'ギフト',
    orderedAt: new Date().toISOString(),
    giftToken: gift.gift_id,
    lineUserId: gift.line_user_id,
    method: '商品・受け取り方法の変更希望',
    address: [note ? `お客様からのメモ: ${note}` : '', contactEmail ? `返信先: ${contactEmail}` : ''].filter(Boolean).join('\n') || null,
    isChangeRequest: true,
  }).catch(err => console.error('notifyStaff error:', err));
  res.json({ ok: true });
});


router.post('/gift-cancel-change-request', async (req, res) => {
  const { giftId } = req.body;
  if (!giftId) return res.status(400).json({ ok: false, error: 'giftId required' });
  const tokenHash = recipientTokenFromRequest(req);
  if (!tokenHash) return res.status(403).json({ ok: false, error: 'recipient token required' });
  const { data, error } = await supabase.from('gifts')
    .update({ change_requested_at: null, change_request_note: null, change_request_contact: null })
    .eq('gift_id', giftId).eq('recipient_token_hash', tokenHash).select('gift_id');
  if (error || !data?.length) return res.status(404).json({ ok: false, error: 'Gift not found' });
  res.json({ ok: true });
});


router.post('/gift-acknowledge-decline', async (req, res) => {
  const { giftId } = req.body;
  if (!giftId) return res.status(400).json({ ok: false, error: 'giftId required' });
  const tokenHash = recipientTokenFromRequest(req);
  if (!tokenHash) return res.status(403).json({ ok: false, error: 'recipient token required' });
  const { data, error } = await supabase.from('gifts').update({ change_request_declined_at: null }).eq('gift_id', giftId).eq('recipient_token_hash', tokenHash).select('gift_id');
  if (error || !data?.length) return res.status(404).json({ ok: false, error: 'Gift not found' });
  res.json({ ok: true });
});


router.post('/gift-receive', async (req, res) => {
  const { giftId, selectedItemId } = req.body;
  if (!giftId) return res.status(400).json({ ok: false, error: 'giftId required' });
  const tokenHash = recipientTokenFromRequest(req);
  if (!tokenHash) return res.status(403).json({ ok: false, error: 'recipient token required' });
  const baseUrl = process.env.BASE_URL;
  try {
    const { data: gift } = await supabase.from('gifts').select('gift_id, status, fulfillment_method, qr_token, selected_item_id, selected_at, items, line_user_id').eq('gift_id', giftId).eq('recipient_token_hash', tokenHash).maybeSingle();
    if (!gift) return res.status(404).json({ ok: false, error: 'Gift not found' });
    if (gift.status === 'refunded') return res.status(403).json({ ok: false, error: 'refunded' });
    if (gift.status !== 'selected' || gift.fulfillment_method !== 'pickup') return res.status(409).json({ ok: false, error: 'select a pickup item first' });

    if (gift.fulfillment_method === 'shipping' && gift.status === 'completed') {
      return res.status(409).json({ ok: false, error: 'already_shipping' });
    }


    if (gift.qr_token) {
      const verifyUrl = `${baseUrl}/gift/verify?token=${gift.qr_token}`;
      const qrDataUrl = await QRCode.toDataURL(verifyUrl);
      return res.json({ ok: true, used: true, qrDataUrl, verifyUrl });
    }

    const qrToken = crypto.randomUUID();
    const now = new Date().toISOString();
    const selId = selectedItemId != null ? String(selectedItemId).slice(0, 64) : gift.selected_item_id;
    if (!Array.isArray(gift.items) || !gift.items.some(i => String(i.id) === selId)) return res.status(400).json({ ok: false, error: 'Invalid item' });


    const { data: claimed } = await supabase.from('gifts')
      .update({
        selected_item_id: selId,
        selected_at: gift.selected_at || now,
        fulfillment_method: 'pickup',
        qr_token: qrToken,
        qr_status: 'issued',
      })
      .eq('gift_id', giftId).eq('recipient_token_hash', tokenHash).eq('status', 'selected').eq('fulfillment_method', 'pickup').is('qr_token', null).select('gift_id');

    if (!claimed || claimed.length === 0) {
      const { data: g2 } = await supabase.from('gifts').select('qr_token').eq('gift_id', giftId).eq('recipient_token_hash', tokenHash).maybeSingle();
      if (!g2?.qr_token) return res.status(409).json({ ok: false, error: 'gift state changed' });
      const verifyUrl = `${baseUrl}/gift/verify?token=${g2.qr_token}`;
      const qrDataUrl = await QRCode.toDataURL(verifyUrl);
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
    const baseUrl = process.env.BASE_URL;
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


function verifyPage(productName, usedAt) {
  const when = usedAt ? new Date(usedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '';
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>受け取り確認</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:#fff;border-radius:20px;padding:40px 28px;text-align:center;max-width:400px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.1)}.icon{font-size:64px;margin-bottom:16px}h1{font-size:22px;color:#4CAF50;margin-bottom:12px}.product{background:#f8fff8;border:1.5px solid #4CAF50;border-radius:12px;padding:16px;margin:16px 0;font-size:17px;font-weight:bold;color:#222}p{color:#888;font-size:13px;line-height:1.7}.when{color:#aaa;font-size:12px;margin-top:8px}</style></head><body><div class="card"><div class="icon">✅</div><h1>受け取り済み</h1><div class="product">${esc(productName)}</div><p>受け取り確認が完了しました。<br>商品をお渡しください。</p>${when ? `<div class="when">受け取り日時: ${esc(when)}</div>` : ''}</div></body></html>`;
}


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

    const now = new Date().toISOString();

    const { data: claimed } = await supabase.from('gifts')
      .update({ status: 'picked_up', qr_status: 'used', used_at: now, change_requested_at: null, change_request_note: null, change_request_contact: null })
      .eq('gift_id', g.gift_id).is('used_at', null).select('gift_id');
    if (claimed && claimed.length > 0) usedAt = now;
  }

  res.send(verifyPage(item.name || 'ギフト', usedAt));
});





router.get('/admin/gifts', async (req, res) => {
  if (!adminAuth(req, res)) return;

  const PAGE_SIZE = 50;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '';
  const toDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '';
  const method = ['pickup', 'shipping'].includes(req.query.method) ? req.query.method : 'all';


  let countQuery = supabase.from('gifts').select('status, change_requested_at, qr_token, fulfillment_method', { count: 'exact' }).neq('status', 'pending');
  let listQuery = supabase.from('gifts').select('*').neq('status', 'pending').order('created_at', { ascending: false });
  if (fromDate) {
    countQuery = countQuery.gte('created_at', `${fromDate}T00:00:00+09:00`);
    listQuery = listQuery.gte('created_at', `${fromDate}T00:00:00+09:00`);
  }
  if (toDate) {
    countQuery = countQuery.lte('created_at', `${toDate}T23:59:59+09:00`);
    listQuery = listQuery.lte('created_at', `${toDate}T23:59:59+09:00`);
  }
  if (method !== 'all') {
    countQuery = countQuery.eq('fulfillment_method', method);
    listQuery = listQuery.eq('fulfillment_method', method);
  }
  listQuery = listQuery.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  const [{ data: statusRows, count: totalCount }, { data: gifts }] = await Promise.all([countQuery, listQuery]);

  const STATUS_LABEL = { pending: '⏳ 離脱（未決済）', paid: '💳 決済完了', selected: '🎯 商品選択済み', picked_up: '✅ 完了', completed: '✅ 完了' };
  const STATUS_COLOR = { pending: '#f59e0b', paid: '#3b82f6', selected: '#8b5cf6', picked_up: '#22c55e', completed: '#22c55e' };

  const counts = { pending: 0, paid: 0, selected: 0, qr_issued: 0, shipping_pending: 0, picked_up: 0, completed: 0, change_requested: 0 };
  (statusRows || []).forEach(g => {
    if (g.status === 'selected') {
      if (g.qr_token) counts.qr_issued++;
      else if (g.fulfillment_method === 'shipping') counts.shipping_pending++;
      else counts.selected++;
    } else if (counts[g.status] !== undefined) {
      counts[g.status]++;
    }
    if (g.change_requested_at) counts.change_requested++;
  });
  const total = totalCount || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }


  function buildProgressDots(g) {
    const methodIcon = g.fulfillment_method === 'shipping' ? '📦' : '📱';
    const steps = [
      { icon: '💳', done: g.status !== 'pending' },
      { icon: '🎯', done: !!g.selected_item_id },
      { icon: methodIcon, done: !!(g.qr_token || g.recipient_address) },
      { icon: '✅', done: g.status === 'picked_up' || g.status === 'completed' },
    ];
    return steps.map((s, i) => {
      const dot = `<span style="display:inline-block;width:18px;height:18px;line-height:18px;border-radius:50%;background:${s.done ? '#22c55e1a' : '#f0f0f0'};font-size:10px;text-align:center;${s.done ? '' : 'filter:grayscale(1) opacity(0.5);'}">${s.icon}</span>`;
      if (i === steps.length - 1) return dot;
      const lineColor = s.done && steps[i + 1].done ? '#22c55e' : '#e0e0e0';
      return `${dot}<span style="display:inline-block;width:8px;height:2px;background:${lineColor};vertical-align:middle;"></span>`;
    }).join('');
  }

  const PENDING_ALERT_DAYS = 2;

  const rows = (gifts || []).map(g => {
    const items = Array.isArray(g.items) ? g.items : [];
    const selected = items.find(i => String(i.id) === String(g.selected_item_id));
    const price = (selected || items[0] || {}).price;

    const isShippingPending = g.status === 'selected' && !g.qr_token && g.fulfillment_method === 'shipping';
    const color = g.status === 'selected' && g.qr_token ? '#6366f1' : isShippingPending ? '#1976d2' : (STATUS_COLOR[g.status] || '#888');
    const label = g.status === 'selected'
      ? (g.qr_token ? '📱 QR発行済み' : isShippingPending ? '📦 配送先入力待ち' : '🎯 商品選択済み')
      : (STATUS_LABEL[g.status] || g.status);
    const date = g.created_at ? new Date(g.created_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

    const candidatesList = items.map(i => {
      const isSelected = selected && i.id === selected.id;
      return `<div style="${isSelected ? 'font-weight:bold;color:#00a000;' : 'color:#999;'}">${isSelected ? '✓ ' : ''}${esc(i.name)}</div>`;
    }).join('');
    const itemsSummary = selected
      ? `<span style="font-weight:bold;color:#00a000;">✓ ${esc(selected.name)}</span>`
      : items.length > 1
        ? `<span style="color:#999;">${items.length}択（未選択）</span>`
        : `<span style="color:#999;">${esc(items[0]?.name || '-')}</span>`;
    const itemsHtml = items.length > 1
      ? `<details><summary style="cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${itemsSummary}</summary><div style="margin-top:4px;font-size:11px;line-height:1.6;white-space:normal;">${candidatesList}</div></details>`
      : `<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">${itemsSummary}</span>`;
    const returnTo = esc(`/admin/gifts?${(() => { const p = new URLSearchParams(); if (fromDate) p.set('from', fromDate); if (toDate) p.set('to', toDate); if (method !== 'all') p.set('method', method); p.set('page', String(page)); return p.toString(); })()}`);

    const pickup = g.used_at
      ? `<span style="color:#22c55e;font-weight:bold;">✅ 受取済</span><br><span style="font-size:10px;color:#aaa;">${new Date(g.used_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>`
      : g.fulfillment_method === 'shipping' && g.status === 'completed'
        ? '<span style="color:#22c55e;font-weight:bold;">✅ 対応完了（配送手続済）</span>'
        : g.fulfillment_method === 'shipping'
          ? '<span style="color:#1976d2;">📦 配送先入力待ち</span>'
          : g.qr_token
            ? `<span style="color:#8b5cf6;">📱 QR発行済</span><div style="margin-top:4px;"><form method="POST" action="/admin/gifts/${encodeURIComponent(g.gift_id)}/confirm-pickup" style="display:inline;" onsubmit="return confirm('QRが読めない等の理由で、手動で受取完了にします。よろしいですか？');"><input type="hidden" name="return" value="${returnTo}"><button type="submit" class="action-btn" style="background:#8b5cf6;">手動受取確認</button></form></div>`
            : '<span style="color:#ccc;">-</span>';


    let reservation;
    if (g.status === 'refunded' || g.status === 'picked_up') {
      reservation = '<span style="color:#ccc;">-</span>';
    } else if (g.selected_item_id) {
      const STOCK_LABEL = { in_stock: '✔ 在庫あり', out_of_stock: '✕ 在庫なし', ordered: '🚚 発注済み（入荷待ち）' };
      const STOCK_COLOR = { in_stock: '#22c55e', out_of_stock: '#e53935', ordered: '#1976d2' };
      const stockBadge = g.stock_status
        ? `<span style="color:${STOCK_COLOR[g.stock_status]};font-weight:bold;">${STOCK_LABEL[g.stock_status]}</span><br><span style="font-size:10px;color:#aaa;">${new Date(g.reservation_confirmed_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>`
        : '<span style="color:#f59e0b;">未確認</span>';
      const stockBtns = Object.entries(STOCK_LABEL).filter(([key]) => key !== g.stock_status).map(([key, lbl]) =>
        `<form method="POST" action="/admin/gifts/${encodeURIComponent(g.gift_id)}/set-stock-status" style="display:inline;"><input type="hidden" name="return" value="${returnTo}"><input type="hidden" name="status" value="${key}"><button type="submit" class="action-btn" style="background:${STOCK_COLOR[key]};">${lbl}</button></form>`
      ).join('');
      reservation = `${stockBadge}<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap;">${stockBtns}</div>`;
    } else {
      reservation = '<span style="color:#ccc;">-</span>';
    }


    const PM_LABEL = { card: '💳 カード', paypay: 'PayPay', konbini: 'コンビニ払い', customer_balance: '銀行振込', link: 'Link' };
    const pmLabel = g.payment_method_type ? (PM_LABEL[g.payment_method_type] || g.payment_method_type) : (g.stripe_payment_intent_id ? '💳 カード' : '-');


    const detailLink = `<a href="/admin/gifts/${encodeURIComponent(g.gift_id)}" style="color:#3b82f6;font-size:12px;">詳細 →</a>`;


    let changeRequestCell = '<span style="color:#ccc;">-</span>';
    if (g.change_requested_at) {
      const reqDate = new Date(g.change_requested_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const resolveBase = `/admin/gifts/${encodeURIComponent(g.gift_id)}/resolve-change-request?return=${encodeURIComponent(returnTo.replace(/&amp;/g, '&'))}`;
      changeRequestCell = `<span style="color:#e53935;font-weight:bold;">⚠️ 変更希望</span><br><span style="font-size:10px;color:#aaa;">${reqDate}</span>${g.change_request_note ? `<div style="font-size:10px;color:#666;margin-top:2px;max-width:140px;white-space:normal;">📝${esc(g.change_request_note)}</div>` : ''}${g.change_request_contact ? `<div style="font-size:10px;color:#1976d2;margin-top:2px;max-width:140px;white-space:normal;">✉️${esc(g.change_request_contact)}</div>` : '<div style="font-size:10px;color:#bbb;margin-top:2px;">連絡先未入力</div>'}<div style="margin-top:4px;display:flex;flex-direction:column;gap:4px;"><a href="${resolveBase}&action=reset" class="action-btn" style="background:#e53935;text-align:center;text-decoration:none;display:block;">選び直し対応（リセット）</a><a href="${resolveBase}&action=decline" class="action-btn" style="background:#888;text-align:center;text-decoration:none;display:block;">対応不可（リセットしない）</a></div>`;
    }


    let rowStyle = '';
    if (g.change_requested_at) {
      rowStyle = ' style="background:#ffebee;"';
    } else if (g.status !== 'refunded' && g.status !== 'picked_up' && g.status !== 'completed') {
      const pendingSince = g.selected_at || g.created_at;
      if (pendingSince && (Date.now() - new Date(pendingSince).getTime()) > PENDING_ALERT_DAYS * 24 * 60 * 60 * 1000) {
        rowStyle = ' style="background:#fff8e1;"';
      }
    }

    return `<tr${rowStyle}>
      <td style="font-size:12px;color:#888;white-space:nowrap;">${esc(date)}</td>
      <td style="font-size:11px;font-family:monospace;color:#aaa;">${esc(g.gift_id)}</td>
      <td style="font-weight:bold;">${esc(g.sender_name)}</td>
      <td style="font-size:12px;line-height:1.6;max-width:160px;">${itemsHtml}</td>
      <td style="font-weight:bold; white-space:nowrap;">${price != null ? '¥' + Number(price).toLocaleString() : '-'}</td>
      <td><span style="background:${color}1a;color:${color};padding:4px 10px;border-radius:12px;font-size:11px;font-weight:bold;white-space:nowrap;">${label}</span><div style="margin-top:6px;white-space:nowrap;">${buildProgressDots(g)}</div></td>
      <td style="font-size:11px;white-space:nowrap;">${pmLabel}</td>
      <td style="font-size:12px;text-align:center;">${pickup}</td>
      <td style="font-size:12px;text-align:center;white-space:nowrap;">${reservation}</td>
      <td style="font-size:12px;text-align:center;white-space:nowrap;">${changeRequestCell}</td>
      <td style="font-size:12px;text-align:center;white-space:nowrap;">${detailLink}</td>
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
.nav{position:sticky;top:0;z-index:20;background:#fff;margin-bottom:20px;padding:10px 0;border-bottom:1px solid #eee}
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
<div class="nav">
  <a href="/admin">📊 ダッシュボード</a>
  <a href="/admin/gifts" class="active">🎁 ギフト管理</a>
  <a href="/admin/health">🔧 システム状態</a>
  <a href="/admin/gifts/export.csv">📥 CSV出力</a>
</div>
<h1>🎁 Giftalk 管理画面</h1>
<p class="sub"><span style="background:#fff8e1;border:1px solid #ffe082;padding:2px 8px;border-radius:4px;">黄色の行</span> = 商品選択から${PENDING_ALERT_DAYS}日以上、受け取り・配送手続きが完了していない取引（取り忘れ・入力忘れの可能性があります）</p>
<div class="method-tabs" style="display:flex;gap:8px;margin-bottom:16px;">
  <a href="/admin/gifts${fromDate || toDate ? '?' + new URLSearchParams({ ...(fromDate ? { from: fromDate } : {}), ...(toDate ? { to: toDate } : {}) }).toString() : ''}" style="padding:7px 16px;border-radius:20px;font-size:13px;font-weight:bold;text-decoration:none;${method === 'all' ? 'background:#00C300;color:#fff;' : 'background:#fff;color:#555;border:1.5px solid #ddd;'}">全件</a>
  <a href="/admin/gifts?${new URLSearchParams({ ...(fromDate ? { from: fromDate } : {}), ...(toDate ? { to: toDate } : {}), method: 'pickup' }).toString()}" style="padding:7px 16px;border-radius:20px;font-size:13px;font-weight:bold;text-decoration:none;${method === 'pickup' ? 'background:#8b5cf6;color:#fff;' : 'background:#fff;color:#555;border:1.5px solid #ddd;'}">📱 店頭受け取りのみ</a>
  <a href="/admin/gifts?${new URLSearchParams({ ...(fromDate ? { from: fromDate } : {}), ...(toDate ? { to: toDate } : {}), method: 'shipping' }).toString()}" style="padding:7px 16px;border-radius:20px;font-size:13px;font-weight:bold;text-decoration:none;${method === 'shipping' ? 'background:#1976d2;color:#fff;' : 'background:#fff;color:#555;border:1.5px solid #ddd;'}">📦 配送のみ</a>
</div>
${method !== 'all' ? '<p class="sub" style="margin-top:-12px;">※受け取り方法が未決定の注文は「全件」タブにのみ表示されます</p>' : ''}
<form class="filter-form" method="get">
  <label>期間:</label>
  <input type="date" name="from" value="${esc(fromDate)}">
  〜
  <input type="date" name="to" value="${esc(toDate)}">
  ${method !== 'all' ? `<input type="hidden" name="method" value="${esc(method)}">` : ''}
  <button type="submit">絞り込む</button>
  ${(fromDate || toDate) ? `<a class="clear" href="/admin/gifts${method !== 'all' ? '?method=' + method : ''}">条件をクリア</a>` : ''}
</form>
<div class="stats">
  <div class="stat" style="border-top-color:#3b82f6"><div class="stat-n" style="color:#3b82f6">${counts.paid}</div><div class="stat-l">💳 決済完了</div></div>
  <div class="stat" style="border-top-color:#8b5cf6"><div class="stat-n" style="color:#8b5cf6">${counts.selected}</div><div class="stat-l">🎯 商品選択済み</div></div>
  <div class="stat" style="border-top-color:#6366f1"><div class="stat-n" style="color:#6366f1">${counts.qr_issued + counts.shipping_pending}</div><div class="stat-l">🔄 受け取り手続き中</div><div style="font-size:11px;color:#aaa;margin-top:2px;">📱QR発行済み ${counts.qr_issued} ／ 📦配送先入力待ち ${counts.shipping_pending}</div></div>
  <div class="stat" style="border-top-color:#22c55e"><div class="stat-n" style="color:#22c55e">${counts.picked_up + counts.completed}</div><div class="stat-l">✅ 完了</div><div style="font-size:11px;color:#aaa;margin-top:2px;">📱店頭 ${counts.picked_up} ／ 📦配送 ${counts.completed}</div></div>
  ${counts.change_requested > 0 ? `<div class="stat" style="border-top-color:#e53935;background:#ffebee;"><div class="stat-n" style="color:#e53935;">${counts.change_requested}</div><div class="stat-l">⚠️ 変更希望</div></div>` : ''}
  <div class="stat"><div class="stat-n">${total}</div><div class="stat-l">合計（該当件数）</div></div>
</div>
<div class="card" style="padding:16px 20px;margin-bottom:20px;">
  <div style="font-size:13px;font-weight:bold;color:#555;margin-bottom:14px;">📊 ステータスの意味（4段階・3つ目は受け取り方法で分岐）</div>
  <div style="display:flex;align-items:center;flex-wrap:wrap;gap:10px;font-size:15px;font-weight:bold;color:#333;background:#f8f9fb;border-radius:10px;padding:14px 16px;margin-bottom:18px;">
    <span>💳 決済完了</span><span style="color:#bbb;">→</span>
    <span>🎯 商品選択済み</span><span style="color:#bbb;">→</span>
    <span>📱 QR発行済み<span style="font-size:11px;font-weight:normal;color:#888;">（店頭）</span> / 📦 配送先入力待ち<span style="font-size:11px;font-weight:normal;color:#888;">（配送）</span></span><span style="color:#bbb;">→</span>
    <span>✅ 完了</span>
  </div>
  <div style="font-size:12px;color:#666;display:flex;flex-direction:column;gap:10px;">
    <div><b>💳 決済完了</b>：送り手の支払いが終わり、受取人にURLが届いた状態。まだ商品を選んでいない</div>
    <div><b>🎯 商品選択済み</b>：受取人が商品を選んだ。受け取り方法（店頭・配送）はまだ決まっていない</div>
    <div><b>📱 QR発行済み</b>：店頭受け取りを選び、QRが発行された。スタッフのスキャン（受け取り）待ちの状態</div>
    <div><b>📦 配送先入力待ち</b>：配送を選んだが、まだ住所を入力していない（通常はすぐ入力されるため一時的な状態です）</div>
    <div><b>✅ 完了</b>：こちらで対応できる範囲が完了した状態。店頭はスタッフがQRをスキャンして受け渡し完了。配送は住所入力が完了した時点（実際にお客様の手元に届いたかは現状確認できません）</div>
    <div><b>⚠️ 変更希望</b>：受取人から受け取り方法の変更依頼があり、対応待ちの状態</div>
  </div>
</div>
<div id="scrollbar-top" style="overflow-x:auto;overflow-y:hidden;height:14px;margin-bottom:2px;"><div id="scrollbar-top-inner" style="height:1px;"></div></div>
<div class="card" id="gifts-table-wrap">
  <table>
    <thead><tr>
      <th>日時</th><th>ギフトID</th><th>送り手</th>
      <th>商品</th><th>金額</th><th>ステータス</th><th>支払い方法</th><th>受け取り</th><th>在庫確認</th><th>変更希望</th><th>詳細</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="11" style="text-align:center;color:#aaa;padding:32px;">データなし</td></tr>'}</tbody>
  </table>
  <div class="pagination">
    ${pageLink(page - 1, '← 前へ', page <= 1)}
    <span class="current">${page} / ${totalPages}</span>
    ${pageLink(page + 1, '次へ →', page >= totalPages)}
  </div>
</div>
<script>
  (function () {
    var top = document.getElementById('scrollbar-top');
    var topInner = document.getElementById('scrollbar-top-inner');
    var wrap = document.getElementById('gifts-table-wrap');
    var table = wrap.querySelector('table');
    function sync() { topInner.style.width = table.scrollWidth + 'px'; }
    sync();
    window.addEventListener('resize', sync);
    top.addEventListener('scroll', function () { wrap.scrollLeft = top.scrollLeft; });
    wrap.addEventListener('scroll', function () { top.scrollLeft = wrap.scrollLeft; });
  })();
</script>
</body></html>`);

  function pageLink(p, label, disabled) {
    if (disabled) return `<a class="disabled">${label}</a>`;
    const params = new URLSearchParams();
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    if (method !== 'all') params.set('method', method);
    params.set('page', String(p));
    return `<a href="/admin/gifts?${params.toString()}">${label}</a>`;
  }
});


router.post('/admin/gifts/:id/refund', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const giftId = req.params.id;
  const returnTo = req.body.return || '/admin/gifts';
  try {
    const { data: gift } = await supabase.from('gifts')
      .select('stripe_payment_intent_id, status, line_user_id')
      .eq('gift_id', giftId).maybeSingle();
    if (!gift) return res.status(404).send('ギフトが見つかりません');
    if (gift.status === 'refunded') return res.status(409).send('すでに返金済みです');
    if (!gift.stripe_payment_intent_id) return res.status(400).send('支払い情報がありません');

    const { data: purchase } = await supabase.from('purchases')
      .select('refunded_at').eq('payment_intent_id', gift.stripe_payment_intent_id).maybeSingle();
    if (purchase?.refunded_at) return res.status(409).send('すでに返金済みです');

    await stripe.refunds.create({ payment_intent: gift.stripe_payment_intent_id });
    const now = new Date().toISOString();
    await supabase.from('purchases').update({ refunded_at: now }).eq('payment_intent_id', gift.stripe_payment_intent_id);
    await supabase.from('gifts').update({ status: 'refunded' }).eq('gift_id', giftId);

    if (gift.line_user_id) {
      const { data: giftRow } = await supabase.from('gifts').select('items, selected_item_id').eq('gift_id', giftId).maybeSingle();
      const items = Array.isArray(giftRow?.items) ? giftRow.items : [];
      const item = items.find(i => String(i.id) === String(giftRow?.selected_item_id)) || items[0] || {};
      lineClient.pushMessage({
        to: gift.line_user_id,
        messages: [{ type: 'text', text: `💴 「${item.name || 'ギフト'}」の返金が完了しました。数日以内にご返金されます。` }],
      }).catch(err => console.error('refund LINE notify error:', err));
    }

    res.redirect(returnTo);
  } catch (err) {
    console.error('Admin gift refund error:', err);
    res.status(500).send('返金処理に失敗しました。管理者に連絡してください。');
  }
});


router.post('/admin/gifts/:id/set-stock-status', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const giftId = req.params.id;
  const { status } = req.body;
  if (!['in_stock', 'out_of_stock', 'ordered'].includes(status)) return res.status(400).send('無効なステータスです');
  await supabase.from('gifts').update({ stock_status: status, reservation_confirmed_at: new Date().toISOString() }).eq('gift_id', giftId);
  res.redirect(req.body.return || '/admin/gifts');
});


router.post('/admin/gifts/:id/release-reservation', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const giftId = req.params.id;
  await supabase.from('gifts').update({ stock_status: null, reservation_confirmed_at: null }).eq('gift_id', giftId);
  res.redirect(req.body.return || '/admin/gifts');
});


function defaultChangeRequestMessage(declined) {
  return declined
    ? `先日いただいた受け取り方法の変更依頼について、申し訳ございませんが、すでに手続きが完了しているため変更できませんでした。\nご不便をおかけして申し訳ございません。ご不明な点がございましたらお問い合わせください。`
    : `先日いただいた受け取り方法の変更依頼について、対応が完了しました。\nギフトのページを再度開いて、受け取り方法を選び直してください。`;
}

async function clearChangeRequestAndNotify(giftId, { declined = false, message = null } = {}) {
  const { data: gift } = await supabase.from('gifts').select('change_request_contact').eq('gift_id', giftId).maybeSingle();
  await supabase.from('gifts')
    .update({ change_requested_at: null, change_request_note: null, change_request_contact: null })
    .eq('gift_id', giftId);
  if (gift?.change_request_contact) {
    notifyCustomer({
      to: gift.change_request_contact,
      subject: declined ? 'ご依頼について（対応不可のご連絡）' : 'ご依頼への対応が完了しました',
      text: message || defaultChangeRequestMessage(declined),
    }).catch(err => console.error('notifyCustomer error:', err));
  }
}


router.post('/admin/gifts/:id/reset-selection', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const giftId = req.params.id;
  await supabase.from('gifts').update({
    selected_item_id: null,
    selected_at: null,
    qr_token: null,
    qr_status: 'unused',
    used_at: null,
    fulfillment_method: null,
    recipient_address: null,
    status: 'paid',
    reservation_confirmed_at: null,
    stock_status: null,
  }).eq('gift_id', giftId);
  await clearChangeRequestAndNotify(giftId, { message: (req.body.message || '').trim() || null });
  res.redirect(req.body.return || '/admin/gifts');
});


router.post('/admin/gifts/:id/decline-change-request', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const giftId = req.params.id;
  await clearChangeRequestAndNotify(giftId, { declined: true, message: (req.body.message || '').trim() || null });

  await supabase.from('gifts').update({ change_request_declined_at: new Date().toISOString() }).eq('gift_id', giftId);
  res.redirect(req.body.return || '/admin/gifts');
});


router.get('/admin/gifts/:id/resolve-change-request', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const giftId = req.params.id;
  const action = req.query.action === 'decline' ? 'decline' : 'reset';
  const { data: g } = await supabase.from('gifts').select('*').eq('gift_id', giftId).maybeSingle();
  if (!g) return res.status(404).send('ギフトが見つかりません');
  function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  const returnTo = esc(req.query.return || '/admin/gifts');
  const defaultMessage = defaultChangeRequestMessage(action === 'decline');
  const actionUrl = action === 'decline'
    ? `/admin/gifts/${encodeURIComponent(giftId)}/decline-change-request`
    : `/admin/gifts/${encodeURIComponent(giftId)}/reset-selection`;
  const title = action === 'decline' ? '対応不可として連絡' : '選び直し対応（リセット）';
  const warn = action === 'reset' && g.fulfillment_method === 'shipping'
    ? '<p style="color:#e53935;font-size:13px;font-weight:bold;margin-bottom:16px;">⚠️発送済みでないか必ず確認してください。発送済みの場合は実行しないでください（二重発送のおそれがあります）。</p>'
    : '';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - ${esc(giftId)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f5f6f8;padding:24px;color:#222}
.card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.06);max-width:560px}
h1{font-size:16px;margin-bottom:4px}
.sub{font-size:12px;color:#888;margin-bottom:16px}
textarea{width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:13px;font-family:inherit;box-sizing:border-box;min-height:120px}
.btn{border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:bold;padding:10px 20px;cursor:pointer;margin-top:14px}
.cancel{display:inline-block;margin-top:14px;margin-left:8px;color:#888;text-decoration:none;font-size:13px;}
</style></head><body>
<div class="card">
  <h1>${esc(title)}</h1>
  <p class="sub">ギフトID: ${esc(giftId)}</p>
  ${warn}
  ${g.change_request_contact
    ? `<label style="font-size:12px;color:#666;display:block;margin-bottom:6px;">送信するメール文面（編集できます）— 送信先: ${esc(g.change_request_contact)}</label>
       <form method="POST" action="${actionUrl}">
         <textarea name="message">${esc(defaultMessage)}</textarea>
         <input type="hidden" name="return" value="${returnTo}">
         <button type="submit" class="btn" style="background:${action === 'decline' ? '#888' : '#e53935'};">この内容で実行する</button>
         <a class="cancel" href="${returnTo}">キャンセル</a>
       </form>`
    : `<p style="font-size:13px;color:#888;margin-bottom:8px;">連絡先（メールアドレス）が未入力のため、メールは送信されません。</p>
       <form method="POST" action="${actionUrl}">
         <input type="hidden" name="return" value="${returnTo}">
         <button type="submit" class="btn" style="background:${action === 'decline' ? '#888' : '#e53935'};">実行する</button>
         <a class="cancel" href="${returnTo}">キャンセル</a>
       </form>`}
</div>
</body></html>`);
});


router.post('/admin/gifts/:id/confirm-pickup', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const giftId = req.params.id;
  await supabase.from('gifts').update({ status: 'picked_up', qr_status: 'used', used_at: new Date().toISOString(), change_requested_at: null, change_request_note: null, change_request_contact: null }).eq('gift_id', giftId);
  res.redirect(req.body.return || '/admin/gifts');
});


router.post('/admin/gifts/:id/resend-url', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const giftId = req.params.id;
  const baseUrl = process.env.BASE_URL;
  try {
    const { data: gift } = await supabase.from('gifts').select('line_user_id').eq('gift_id', giftId).maybeSingle();
    if (gift?.line_user_id) {
      const recipientToken = createRecipientToken();
      const { error } = await supabase.from('gifts').update({ recipient_token_hash: hashRecipientToken(recipientToken) }).eq('gift_id', giftId);
      if (error) throw error;
      const shareUrl = `${baseUrl}/g/${encodeURIComponent(giftId)}?token=${recipientToken}`;
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


router.get('/admin/gifts/:id', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const giftId = req.params.id;
  const { data: g } = await supabase.from('gifts').select('*').eq('gift_id', giftId).maybeSingle();
  if (!g) return res.status(404).send('ギフトが見つかりません');

  function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  const returnTo = esc(`/admin/gifts/${encodeURIComponent(giftId)}`);
  const items = Array.isArray(g.items) ? g.items : [];
  const selectedItem = items.find(i => String(i.id) === String(g.selected_item_id));

  const PM_LABEL = { card: '💳 カード', paypay: 'PayPay', konbini: 'コンビニ払い', customer_balance: '銀行振込', link: 'Link' };
  const pmLabel = g.payment_method_type ? (PM_LABEL[g.payment_method_type] || g.payment_method_type) : (g.stripe_payment_intent_id ? '💳 カード' : '-');

  let resendCell = '<span style="color:#ccc;">URL再送は対象外です（受取済・返金済、またはLINE未取得）</span>';
  if (g.status !== 'refunded' && g.status !== 'picked_up' && g.line_user_id) {
    resendCell = `<form method="POST" action="/admin/gifts/${encodeURIComponent(g.gift_id)}/resend-url"><input type="hidden" name="return" value="${returnTo}"><button type="submit" class="action-btn" style="background:#3b82f6;padding:8px 16px;">URLを再送する</button></form>`;
  }

  const REFUND_DAYS = 90;
  const refundDeadline = g.created_at ? new Date(new Date(g.created_at).getTime() + REFUND_DAYS * 24 * 60 * 60 * 1000) : null;
  const canRefund = refundDeadline && Date.now() < refundDeadline.getTime();
  const refundDeadlineStr = refundDeadline ? refundDeadline.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }) : '';
  let refundCell;
  if (g.status === 'refunded') {
    refundCell = '<span style="color:#e53935;font-weight:bold;">返金済</span>';
  } else if (g.stripe_payment_intent_id && canRefund) {
    refundCell = `<p style="font-size:12px;color:#888;margin-bottom:8px;">返金期限: ${refundDeadlineStr}まで</p><form method="POST" action="/admin/gifts/${encodeURIComponent(g.gift_id)}/refund" onsubmit="return confirm('この注文を返金しますか？\\nこの操作は取り消せません。');"><input type="hidden" name="return" value="${returnTo}"><button type="submit" class="action-btn" style="background:#e53935;padding:8px 16px;">返金する</button></form>`;
  } else if (g.stripe_payment_intent_id && !canRefund) {
    refundCell = `<span style="color:#ccc;">返金期限切れ（${refundDeadlineStr}まで）</span>`;
  } else {
    refundCell = '<span style="color:#ccc;">支払い情報がありません</span>';
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ギフト詳細 - ${esc(g.gift_id)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f5f6f8;padding:24px;color:#222}
.nav{position:sticky;top:0;z-index:20;background:#fff;margin-bottom:20px;padding:10px 0;border-bottom:1px solid #eee}
.nav a{text-decoration:none;color:#3b82f6;font-size:13px;margin-right:16px}
h1{font-size:18px;margin-bottom:4px;font-family:monospace;}
.sub{font-size:13px;color:#888;margin-bottom:20px}
.card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.06);margin-bottom:16px}
.card h2{font-size:14px;color:#555;margin-bottom:12px}
.row{display:flex;gap:8px;margin-bottom:8px;font-size:13px}
.row .label{color:#888;min-width:120px;}
.action-btn{border:none;border-radius:6px;color:#fff;font-size:13px;padding:6px 10px;cursor:pointer}
</style></head><body>
<div class="nav"><a href="/admin/gifts">← ギフト一覧に戻る</a></div>
<h1>${esc(g.gift_id)}</h1>
<p class="sub">${g.created_at ? new Date(g.created_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : ''}</p>

<div class="card">
  <h2>📦 注文情報</h2>
  <div class="row"><span class="label">送り手</span><span>${esc(g.sender_name)}</span></div>
  <div class="row"><span class="label">メッセージ</span><span>${esc(g.occasion_text || '-')}</span></div>
  <div class="row"><span class="label">商品候補</span><span>${items.map(i => esc(i.name)).join(' / ') || '-'}</span></div>
  <div class="row"><span class="label">選択された商品</span><span>${selectedItem ? esc(selectedItem.name) : '未選択'}</span></div>
  <div class="row"><span class="label">ステータス</span><span>${esc(g.status)}</span></div>
  <div class="row"><span class="label">支払い方法</span><span>${pmLabel}</span></div>
  <div class="row"><span class="label">受け取り方法</span><span>${esc(g.fulfillment_method || '-')}</span></div>
  <div class="row"><span class="label">配送先</span><span>${esc(g.recipient_address || '-')}</span></div>
</div>

<div class="card">
  <h2>🧪 A/Bテスト情報</h2>
  <div class="row"><span class="label">OGPデザイン</span><span>${esc(g.ogp_design_variant || '-')}</span></div>
  <div class="row"><span class="label">AIコメント</span><span>${esc(g.comment_variant || '-')}</span></div>
  ${g.ai_share_comment ? `<div class="row"><span class="label">生成コメント</span><span style="color:#444;">${esc(g.ai_share_comment)}</span></div>` : ''}
  ${g.sender_prediction ? `<div class="row"><span class="label">送り手の予想</span><span>${esc(items.find(i => String(i.id) === String(g.sender_prediction))?.name || g.sender_prediction)}</span></div>` : ''}
  ${g.sender_prediction && g.selected_item_id ? `<div class="row"><span class="label">予想結果</span><span style="font-weight:bold;color:${String(g.sender_prediction) === String(g.selected_item_id) ? '#00a000' : '#e53935'};">${String(g.sender_prediction) === String(g.selected_item_id) ? '✅ 一致' : '❌ 不一致'}</span></div>` : ''}
</div>

<div class="card">
  <h2>📧 URL再送</h2>
  ${resendCell}
</div>

<div class="card">
  <h2>💴 返金</h2>
  ${refundCell}
</div>
</body></html>`);
});

router.get('/admin', async (req, res) => {
  if (!adminAuth(req, res)) return;

  const [{ data: purchases }, { count: convCount }, { data: productListData }, { data: funnelData }, { data: recViewData }, { data: giftsSelectedData }, { data: abData }] = await Promise.all([
    supabase.from('purchases').select('*').order('timestamp', { ascending: false }).limit(500),
    supabase.from('conversation_logs').select('*', { count: 'exact', head: true }),
    supabase.from('products').select('*').order('is_active', { ascending: false }).order('id'),
    supabase.from('funnel_events').select('event_type, user_id, product_id'),
    supabase.from('funnel_events').select('product_id, user_id').eq('event_type', 'rec_view').not('product_id', 'is', null),
    supabase.from('gifts').select('items, selected_item_id, line_user_id').not('selected_item_id', 'is', null),
    supabase.from('gifts').select('ogp_design_variant, comment_variant, sender_prediction, selected_item_id').neq('status', 'pending'),
  ]);


  const statsRows = { rows: [{ count: String((purchases || []).length), total: String((purchases || []).reduce((s, p) => s + Number(p.amount), 0)) }] };


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


  function getSelectedItem(g) {
    const items = Array.isArray(g.items) ? g.items : [];
    return items.find(i => String(i.id) === String(g.selected_item_id));
  }


  const rankMap = {};
  (giftsSelectedData || []).forEach(g => {
    const item = getSelectedItem(g);
    if (item?.name) {
      if (!rankMap[item.name]) rankMap[item.name] = { count: 0, revenue: 0 };
      rankMap[item.name].count += 1;
      rankMap[item.name].revenue += Number(item.price) || 0;
    }
  });
  const rankingRows = { rows: Object.entries(rankMap).sort(([, a], [, b]) => b.revenue - a.revenue).slice(0, 5).map(([product_name, v]) => ({ product_name, count: v.count, revenue: v.revenue })) };


  const funnelMap = {};
  (funnelData || []).forEach(r => { funnelMap[r.event_type] = (funnelMap[r.event_type] || 0) + 1; });
  const funnelRows = { rows: Object.entries(funnelMap).map(([event_type, count]) => ({ event_type, count })) };


  const recMap = {};
  (recViewData || []).forEach(r => { if (!recMap[r.product_id]) recMap[r.product_id] = new Set(); recMap[r.product_id].add(r.user_id); });
  const buyMap = {};
  (giftsSelectedData || []).forEach(g => {
    const item = getSelectedItem(g);
    if (item?.id) buyMap[item.id] = (buyMap[item.id] || 0) + 1;
  });
  const pNameMap = Object.fromEntries((productListData || []).map(p => [p.id, p.name]));
  const recRows = { rows: Object.entries(recMap).filter(([pid]) => pNameMap[pid]).map(([pid, users]) => ({ product_id: pid, name: pNameMap[pid], rec_count: users.size, buy_count: buyMap[pid] || 0 })).sort((a, b) => b.rec_count - a.rec_count).slice(0, 10) };


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

  const { count, total } = statsRows.rows[0];
  const fd = {
    liff_open: funnelMap['liff_open'] || 0,
    product_select: funnelMap['product_select'] || 0,
    payment_init: funnelMap['payment_init'] || 0,
    payment_complete: funnelMap['payment_complete'] || 0,
  };
  const recData = recRows.rows;


  const abGroups = { 'simple×none': 0, 'simple×ai_generated': 0, 'fancy×none': 0, 'fancy×ai_generated': 0 };
  let predTotal = 0, predMatched = 0;
  (abData || []).forEach(g => {
    const design = g.ogp_design_variant || 'simple';
    const comment = g.comment_variant || 'none';
    const key = `${design}×${comment}`;
    if (key in abGroups) abGroups[key]++;
    if (g.sender_prediction && g.selected_item_id) {
      predTotal++;
      if (String(g.sender_prediction) === String(g.selected_item_id)) predMatched++;
    }
  });
  const predMatchRate = predTotal > 0 ? (predMatched / predTotal * 100).toFixed(1) : null;

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
  <div class="topnav">
    <a href="/admin">📊 ダッシュボード</a>
    <a href="/admin/gifts">🎁 ギフト管理</a>
    <a href="/admin/products">📦 商品管理</a>
    <a href="/admin/health">🔧 システム状態</a>
  </div>
  <h1>管理画面</h1>
  <div class="stats">
    <div class="stat-card"><div class="label">総購入数</div><div class="value">${count}件</div></div>
    <div class="stat-card"><div class="label">総売上</div><div class="value">¥${Number(total).toLocaleString()}</div></div>
    <div class="stat-card"><div class="label">会話ログ数</div><div class="value blue">${convCount || 0}件</div></div>
  </div>
  <div class="section">
    <h2>📈 直近7日間の売上</h2>
    <div class="chart-card"><canvas id="salesChart" height="90"></canvas></div>
  </div>
  <div class="chart-grid">
    <div><h2>🏆 商品別売上合計額 TOP5</h2><div class="chart-card"><canvas id="rankingChart" height="220"></canvas></div></div>
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
    <h2>🧪 A/Bテスト状況</h2>
    <p style="font-size:12px;color:#888;margin-bottom:12px;">OGPデザイン × AIコメントの4グループ分布と、送り手予想の一致率</p>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
      ${Object.entries({ 'simple×none': ['シンプル', 'なし', '#888'], 'simple×ai_generated': ['シンプル', 'AIあり', '#1976d2'], 'fancy×none': ['リッチ', 'なし', '#8b5cf6'], 'fancy×ai_generated': ['リッチ', 'AIあり', '#00a000'] }).map(([key, [design, comment, color]]) => `
        <div class="stat-card" style="min-width:110px;border-top:3px solid ${color};">
          <div class="label">OGP: ${design} / コメント: ${comment}</div>
          <div class="value" style="color:${color};font-size:22px;">${abGroups[key]}件</div>
        </div>`).join('')}
      <div class="stat-card" style="min-width:150px;border-top:3px solid #f57c00;">
        <div class="label">送り手予想 一致率</div>
        <div class="value" style="color:${predMatchRate !== null && Number(predMatchRate) >= 50 ? '#00C300' : predMatchRate !== null ? '#f57c00' : '#aaa'};font-size:22px;">${predMatchRate !== null ? predMatchRate + '%' : '-'}</div>
        <div style="font-size:11px;color:#aaa;margin-top:4px;">${predTotal}件回答 / ${predMatched}件一致</div>
      </div>
    </div>
  </div>
  <div class="section">
    <h2>🤖 AI会話の要約（顧客ニーズ分析）</h2>
    <div style="background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.1);">
      <p style="font-size:13px;color:#666;margin-bottom:10px;">期間を指定して、その期間の会話ログをAIが要約します。</p>
      <a href="/admin/summarize-range" style="display:inline-block;background:#7b1fa2;color:#fff;text-decoration:none;padding:8px 18px;border-radius:6px;font-size:13px;">期間を選んで要約を作成 →</a>
    </div>
  </div>
  <div class="section">
    <h2>📁 データのエクスポート</h2>
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <a href="/admin/export/purchases.csv" style="background:#1976d2;color:#fff;text-decoration:none;padding:8px 16px;border-radius:8px;font-size:13px;">📥 購入履歴 CSV</a>
      <a href="/admin/export/conversation-logs.csv" style="background:#1976d2;color:#fff;text-decoration:none;padding:8px 16px;border-radius:8px;font-size:13px;">📥 会話ログ CSV</a>
    </div>
  </div>
  <script>
    const salesLabels = ${JSON.stringify(dailyRows.rows.map(r => r.day))};
    const salesData = ${JSON.stringify(dailyRows.rows.map(r => Number(r.total)))};
    const rankLabels = ${JSON.stringify(rankingRows.rows.map(r => r.product_name.length > 14 ? r.product_name.slice(0, 14) + '…' : r.product_name))};
    const rankData = ${JSON.stringify(rankingRows.rows.map(r => Number(r.revenue)))};
    const rankCounts = ${JSON.stringify(rankingRows.rows.map(r => Number(r.count)))};
    new Chart(document.getElementById('salesChart'), { type: 'bar', data: { labels: salesLabels.length ? salesLabels : ['データなし'], datasets: [{ label: '売上（円）', data: salesLabels.length ? salesData : [0], backgroundColor: '#00C300', borderRadius: 4, maxBarThickness: 64 }] }, options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } } });
    new Chart(document.getElementById('rankingChart'), { type: 'bar', data: { labels: rankLabels.length ? rankLabels : ['データなし'], datasets: [{ data: rankLabels.length ? rankData : [0], backgroundColor: '#00C300', borderRadius: 4, maxBarThickness: 28 }] }, options: { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(ctx) { return '¥' + ctx.parsed.x.toLocaleString() + '（' + (rankCounts[ctx.dataIndex] || 0) + '件）'; } } } }, scales: { x: { beginAtZero: true, ticks: { callback: function(v) { return '¥' + v.toLocaleString(); } } } } } });
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


router.get('/admin/summarize-range', async (req, res) => {
  if (!adminAuth(req, res)) return;
  function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '';
  const toDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '';

  let summary = '';
  let logCount = 0;
  let errorMsg = '';

  if (fromDate && toDate) {
    try {
      const { data: logs } = await supabase.from('conversation_logs').select('*')
        .gte('timestamp', `${fromDate}T00:00:00+09:00`)
        .lte('timestamp', `${toDate}T23:59:59+09:00`)
        .order('id', { ascending: true })
        .limit(500);
      logCount = logs?.length || 0;

      if (logCount === 0) {
        errorMsg = 'この期間に会話ログがありません。';
      } else {
        const transcript = logs.map(l => `[${new Date(l.timestamp).toLocaleString('ja-JP')}]\nお客様: ${l.user_message}\nAI: ${l.ai_response}${Array.isArray(l.recommendations) && l.recommendations.length ? `\n（提案商品: ${l.recommendations.join(', ')}）` : ''}`).join('\n\n');
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const prompt = `以下は実店舗のギフト相談AIとお客様との会話ログです（${logCount}件）。\n実証実験の分析担当者向けに、以下の観点で日本語で簡潔に要約してください。\n\n1. よくあるシーン・贈る相手・予算帯の傾向\n2. お客様が困っている点・要望・不満（あれば）\n3. AIがうまく提案できなかった/答えられなかったケース\n4. その他、商品ラインナップや接客の改善につながりそうな気づき\n\n箇条書きで、各項目2〜4行程度にまとめてください。マークダウンの見出し記号（#など）は使わず、「1.」「2.」のような番号付き箇条書きで書いてください。\n\n--- 会話ログ ---\n${transcript}`;
        const result = await model.generateContent(prompt);
        summary = result.response.text().trim();
      }
    } catch (err) {
      console.error('summarize-range error:', err);
      errorMsg = '要約の生成に失敗しました。時間をおいて再度お試しください。';
    }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI会話の要約</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f5f5f5;padding:24px;color:#222}
.nav{position:sticky;top:0;z-index:20;background:#f5f5f5;display:flex;gap:18px;flex-wrap:wrap;padding:10px 0;margin-bottom:20px;border-bottom:1px solid #e3e3e3}
.nav a{text-decoration:none;color:#555;font-size:13px;font-weight:bold}
h1{font-size:20px;margin-bottom:16px}
.card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.1);margin-bottom:20px;max-width:680px}
.filter-form{display:flex;align-items:center;gap:8px;margin-bottom:20px;flex-wrap:wrap;font-size:13px}
.filter-form input[type=date]{padding:6px 8px;border:1px solid #ddd;border-radius:6px;font-size:13px}
.filter-form button{padding:7px 16px;border:none;border-radius:6px;background:#7b1fa2;color:#fff;font-size:13px;cursor:pointer}
</style></head><body>
<div class="nav"><a href="/admin">📊 ダッシュボード</a><a href="/admin/gifts">🎁 ギフト管理</a></div>
<h1>🤖 AI会話の要約（顧客ニーズ分析）</h1>
<form class="filter-form" method="get">
  <label>期間:</label>
  <input type="date" name="from" value="${esc(fromDate)}" required>
  〜
  <input type="date" name="to" value="${esc(toDate)}" required>
  <button type="submit">要約を作成</button>
</form>
${errorMsg ? `<p style="color:#e53935;font-size:13px;margin-bottom:16px;">${esc(errorMsg)}</p>` : ''}
${summary ? `<div class="card"><div style="font-size:12px;color:#888;margin-bottom:10px;">${esc(fromDate)} 〜 ${esc(toDate)}（${logCount}件の会話ログ）</div><div style="font-size:13px;line-height:1.8;white-space:pre-wrap;">${esc(summary)}</div></div>` : ''}
</body></html>`);
});


router.post('/admin/refund', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { purchaseId, paymentIntentId, userId, productName } = req.body;
  if (!paymentIntentId || !/^pi_[a-zA-Z0-9_]{20,}$/.test(paymentIntentId)) {
    return res.status(400).send('無効な支払いIDです');
  }
  const { data: purchaseCheck } = await supabase.from('purchases')
    .select('payment_intent_id, refunded_at').eq('id', purchaseId).maybeSingle();
  if (!purchaseCheck) return res.status(404).send('購入記録が見つかりません');
  if (purchaseCheck.payment_intent_id !== paymentIntentId) return res.status(403).send('支払いIDが一致しません');
  if (purchaseCheck.refunded_at) return res.status(409).send('すでに返金済みです');
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
    res.status(500).send('返金処理に失敗しました。管理者に連絡してください。');
  }
});


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


router.get('/admin/export/conversation-logs.csv', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { data: allLogs } = await supabase.from('conversation_logs').select('*').order('timestamp', { ascending: false });
  const header = '日時,ユーザーID,ユーザー発言,AI返答,AI推薦数,送信元';
  const lines = (allLogs || []).map(c => [
    new Date(c.timestamp).toLocaleString('ja-JP'),
    c.user_id,
    `"${(c.user_message || '').replace(/"/g, '""')}"`,
    `"${(c.ai_response || '').replace(/"/g, '""')}"`,
    Array.isArray(c.recommendations) ? c.recommendations.length : 0,
    c.source === 'liff_chat' ? 'サイト内' : 'LINEトーク',
  ].join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="conversation-logs.csv"');
  res.send('﻿' + [header, ...lines].join('\n'));
});


router.post('/admin/products/:id/toggle', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const productId = req.params.id;
  if (!productId) return res.status(400).send('商品IDが必要です');
  const { data: cur } = await supabase.from('products').select('is_active').eq('id', productId).single();
  await supabase.from('products').update({ is_active: !cur?.is_active }).eq('id', productId);
  invalidateProductsCache();
  res.redirect('/admin/products');
});


router.post('/admin/products', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { id, name, amount, category, description } = req.body;
  if (!id || !name || !amount || !category) return res.status(400).send('必須項目が不足しています');
  try {
    await supabase.from('products').insert({ id: id.trim(), name: name.trim(), amount: Number(amount), currency: 'jpy', category: category.trim(), description: (description || '').trim() });
    invalidateProductsCache();
    res.redirect('/admin/products');
  } catch (err) {
    console.error('Product add error:', err);
    res.status(500).send('商品追加に失敗しました。入力値を確認してください。');
  }
});


router.post('/admin/import/products', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { csv } = req.body;
  if (!csv) return res.redirect('/admin/products');
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
  res.redirect(`/admin/products?imported=${inserted}&skipped=${skipped}`);
});


router.get('/admin/products', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { data: productListData } = await supabase.from('products').select('*').order('is_active', { ascending: false }).order('id');
  function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  const importedMsg = req.query.imported ? `✅ ${req.query.imported}件追加、${req.query.skipped}件スキップしました` : '';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>商品管理</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f5f5f5;padding:24px;color:#222}
.nav{position:sticky;top:0;z-index:20;background:#f5f5f5;display:flex;gap:18px;flex-wrap:wrap;padding:10px 0;margin-bottom:20px;border-bottom:1px solid #e3e3e3}
.nav a{text-decoration:none;color:#555;font-size:13px;font-weight:bold}
.nav a.active{color:#00C300}
h1{font-size:22px;margin-bottom:16px}
.section{margin-bottom:28px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)}
th{background:#f0f0f0;padding:10px 12px;text-align:left;font-size:12px;color:#555}
td{padding:10px 12px;font-size:13px;border-top:1px solid #f0f0f0;color:#333}
.uid{font-family:monospace;font-size:11px;color:#aaa}
.badge{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:bold;display:inline-block}
.badge-ok{background:#e8f5e9;color:#2e7d32}
.btn-sm{font-size:12px;padding:4px 10px;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form-grid input{width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px}
.form-grid label{font-size:12px;color:#888;display:block;margin-bottom:4px}
</style></head><body>
<div class="nav">
  <a href="/admin">📊 ダッシュボード</a>
  <a href="/admin/gifts">🎁 ギフト管理</a>
  <a href="/admin/products" class="active">📦 商品管理</a>
  <a href="/admin/health">🔧 システム状態</a>
</div>
<h1>📦 商品管理</h1>
${importedMsg ? `<div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:12px 16px;margin-bottom:16px;color:#2e7d32;font-size:13px;">${importedMsg}</div>` : ''}
<div class="section">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
    <h2 style="font-size:14px;color:#555;">商品一覧</h2>
    <div style="display:flex;gap:8px;">
      <button class="btn-sm" onclick="var f=document.getElementById('import-pf');f.style.display=f.style.display==='none'?'block':'none'">📥 CSV一括追加</button>
      <button class="btn-sm" onclick="var f=document.getElementById('add-pf');f.style.display=f.style.display==='none'?'block':'none'">＋ 商品を追加</button>
    </div>
  </div>
  <div id="import-pf" style="display:none;background:#fff;border-radius:12px;padding:20px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,0.1);">
    <p style="font-size:12px;color:#888;margin-bottom:8px;">1行1商品でCSVを貼り付けてください。形式: <code>商品ID,商品名,金額(円),カテゴリ,説明</code></p>
    <form method="POST" action="/admin/import/products">
      <textarea name="csv" rows="8" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:12px;font-family:monospace;" placeholder="gift_100,商品名,1000,カテゴリ,説明"></textarea>
      <button type="submit" style="margin-top:8px;background:#1976d2;color:#fff;border:none;border-radius:8px;padding:8px 20px;font-size:13px;cursor:pointer;">インポート実行</button>
    </form>
  </div>
  <div id="add-pf" style="display:none;background:#fff;border-radius:12px;padding:20px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,0.1);">
    <form method="POST" action="/admin/products">
      <div class="form-grid">
        <div><label>商品ID（例: gift_052）</label><input name="id" required placeholder="gift_052"></div>
        <div><label>商品名</label><input name="name" required placeholder="ギフト商品 A"></div>
        <div><label>金額（円）</label><input name="amount" type="number" required placeholder="500"></div>
        <div><label>カテゴリ</label><input name="category" required placeholder="カフェ"></div>
        <div style="grid-column:1/-1"><label>説明文</label><input name="description" placeholder="商品の説明を入力..."></div>
        <div style="grid-column:1/-1"><button type="submit" style="background:#00C300;color:#fff;border:none;border-radius:8px;padding:10px 24px;font-size:14px;cursor:pointer;">追加する</button></div>
      </div>
    </form>
  </div>
  <table>
    <thead><tr><th>ID</th><th>商品名</th><th>金額</th><th>カテゴリ</th><th>状態</th><th>操作</th></tr></thead>
    <tbody>
      ${(productListData || []).map(p => `<tr>
        <td class="uid">${esc(p.id)}</td><td>${esc(p.name)}</td><td>¥${Number(p.amount).toLocaleString()}</td><td>${esc(p.category)}</td>
        <td><span class="badge ${p.is_active ? 'badge-ok' : ''}" style="${p.is_active ? '' : 'background:#eee;color:#999;'}">${p.is_active ? '有効' : '無効'}</span></td>
        <td><form method="POST" action="/admin/products/${esc(p.id)}/toggle" style="display:inline;"><button type="submit" class="btn-sm">${p.is_active ? '無効にする' : '有効にする'}</button></form></td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>
</body></html>`);
});


router.get('/admin/health', async (req, res) => {
  if (!adminAuth(req, res)) return;

  const checks = {};


  try {
    const t0 = Date.now();
    const { error } = await supabase.from('gifts').select('gift_id', { count: 'exact', head: true }).limit(1);
    checks.supabase = error ? { ok: false, msg: 'クエリエラー' } : { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    checks.supabase = { ok: false, msg: e.message };
  }


  try {
    const t0 = Date.now();
    await stripe.balance.retrieve();
    checks.stripe = { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    checks.stripe = { ok: false, msg: e.message };
  }


  const resendKey = process.env.RESEND_API_KEY;
  checks.resend = resendKey ? { ok: true } : { ok: false, msg: 'RESEND_API_KEY が未設定' };


  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!lineToken) {
    checks.line = { ok: false, msg: 'LINE_CHANNEL_ACCESS_TOKEN が未設定' };
  } else {
    try {
      const t0 = Date.now();
      const r = await fetch('https://api.line.me/v2/bot/info', {
        headers: { Authorization: `Bearer ${lineToken}` },
      });
      const json = await r.json();
      checks.line = r.ok ? { ok: true, ms: Date.now() - t0, name: json.displayName || '' } : { ok: false, msg: json.message || `HTTP ${r.status}` };
    } catch (e) {
      checks.line = { ok: false, msg: e.message };
    }
  }


  const requiredEnvs = ['BASE_URL', 'LIFF_ID', 'GOOGLE_AI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'ADMIN_USER', 'ADMIN_PASS'];
  const missingEnvs = requiredEnvs.filter(k => !process.env[k]);

  const allOk = Object.values(checks).every(c => c.ok) && missingEnvs.length === 0;
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  const row = (label, c) => {
    const icon = c.ok ? '✅' : '❌';
    const detail = c.ok ? (c.ms !== undefined ? `${c.ms}ms${c.name ? ' / ' + c.name : ''}` : 'OK') : c.msg;
    const bg = c.ok ? '' : 'background:#fff5f5';
    return `<tr style="${bg}"><td>${icon} ${label}</td><td style="color:${c.ok ? '#2e7d32' : '#c62828'}">${detail}</td></tr>`;
  };

  res.send(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>システム状態</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #f5f5f5; padding: 24px; }
    .topnav { position: sticky; top: 0; z-index: 20; background: #f5f5f5; display: flex; gap: 18px; flex-wrap: wrap; padding: 10px 0; margin-bottom: 28px; border-bottom: 1px solid #e3e3e3; }
    .topnav a { color: #555; text-decoration: none; font-size: 13px; font-weight: bold; }
    .topnav a.active { color: #00C300; }
    .topnav a:hover { color: #00C300; }
    h1 { font-size: 22px; margin-bottom: 6px; }
    .sub { font-size: 12px; color: #888; margin-bottom: 24px; }
    .banner { padding: 14px 20px; border-radius: 10px; font-size: 15px; font-weight: bold; margin-bottom: 24px; }
    .banner.ok { background: #e8f5e9; color: #2e7d32; border: 1px solid #a5d6a7; }
    .banner.ng { background: #ffebee; color: #c62828; border: 1px solid #ef9a9a; }
    table { width: 100%; max-width: 560px; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.1); margin-bottom: 24px; }
    th { background: #f0f0f0; padding: 10px 14px; text-align: left; font-size: 12px; color: #555; }
    td { padding: 11px 14px; font-size: 13px; border-top: 1px solid #f5f5f5; }
    .warn-box { background: #fff8e1; border: 1px solid #ffe082; border-radius: 10px; padding: 14px 18px; max-width: 560px; margin-bottom: 24px; font-size: 13px; }
    .warn-box ul { margin: 8px 0 0 16px; }
    .warn-box li { margin: 4px 0; color: #c62828; font-family: monospace; }
    .btn { display: inline-block; margin-top: 4px; padding: 8px 18px; background: #3b82f6; color: #fff; text-decoration: none; border-radius: 8px; font-size: 13px; }
    .links { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 24px; }
  </style>
</head>
<body>
  <div class="topnav">
    <a href="/admin">📊 ダッシュボード</a>
    <a href="/admin/gifts">🎁 ギフト管理</a>
    <a href="/admin/health" class="active">🔧 システム状態</a>
    <a href="/admin/gifts/export.csv">📥 CSV出力</a>
  </div>
  <h1>🔧 システム状態</h1>
  <div class="sub">確認日時: ${now}</div>

  <div class="banner ${allOk ? 'ok' : 'ng'}">
    ${allOk ? '✅ すべての接続が正常です' : '❌ 一部の接続に問題があります'}
  </div>

  <table>
    <thead><tr><th>サービス</th><th>状態</th></tr></thead>
    <tbody>
      ${row('Supabase（DB）', checks.supabase)}
      ${row('Stripe（決済）', checks.stripe)}
      ${row('Resend（メール）', checks.resend)}
      ${row('LINE Messaging API', checks.line)}
    </tbody>
  </table>

  ${missingEnvs.length > 0 ? `
  <div class="warn-box">
    <strong>⚠️ 未設定の環境変数</strong>
    <ul>${missingEnvs.map(k => `<li>${k}</li>`).join('')}</ul>
  </div>` : ''}

  <p style="font-size:12px;color:#aaa;">ページを再読み込みすると再チェックします</p>
</body>
</html>`);
});


app.use('/api', router);
app.use('/', router);

module.exports = app;
