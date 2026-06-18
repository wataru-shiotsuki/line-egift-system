const express = require('express');
const Stripe = require('stripe');
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const lineClient = require('../lib/line');
const { getActiveProducts } = require('../lib/products');
const { buildGiftFlex } = require('../lib/flex');
const app = express();
app.post('*', async (req, res) => {
  const rawBody = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  console.log('[Stripe] event received:', event.type);
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const { lineUserId, productId, giftMessage, giftType, giftId } = pi.metadata || {};
    if (giftType === 'giftalk') {
      try {
        const baseUrl = process.env.BASE_URL || 'https://your-domain.example.com';
        const shareUrl = `${baseUrl}/gift/select.html?gift=${giftId}`;
        const { data: giftRow } = await supabase.from('gifts')
          .update({ status: 'paid', stripe_payment_intent_id: pi.id })
          .eq('gift_id', giftId)
          .select('items, sender_name, occasion_text')
          .maybeSingle();
        const items = Array.isArray(giftRow?.items) ? giftRow.items : [];
        const firstItem = items[0] || {};
        const { error: purchaseError } = await supabase.from('purchases').insert({
          user_id: lineUserId || null,
          product_id: firstItem.id || null,
          product_name: items.map(i => i.name).join(' / ') || 'Giftalk',
          amount: pi.amount,
          payment_intent_id: pi.id,
          gift_message: giftRow?.occasion_text || '',
          sender_name: giftRow?.sender_name || '',
        });
        if (purchaseError && purchaseError.code !== '23505') {
          console.error('[Giftalk] purchases insert error:', purchaseError);
        }
        if (lineUserId) {
          await supabase.from('funnel_events').insert({ user_id: lineUserId, event_type: 'payment_complete', product_id: firstItem.id || null });
        }
        if (lineUserId) {
          await lineClient.pushMessage({
            to: lineUserId,
            messages: [{
              type: 'text',
              text: `🎁 ギフトURLが発行されました！\n\n受取人にこのURLを送ってください👇\n${shareUrl}`,
            }],
          });
        }
        console.log(`[Giftalk] Gift URL sent for giftId=${giftId}`);
      } catch (err) {
        console.error('[Giftalk] Webhook processing error:', err);
      }
      res.sendStatus(200);
      return;
    }
    if (!lineUserId) { res.sendStatus(200); return; }
    try {
      const allProducts = await getActiveProducts();
      const product = allProducts[productId];
      let senderName = '';
      try {
        const profile = await lineClient.getProfile(lineUserId);
        senderName = profile.displayName;
      } catch {}
      const { error: purchaseError } = await supabase.from('purchases').insert({
        user_id: lineUserId,
        product_id: productId,
        product_name: product?.name || '',
        amount: pi.amount,
        payment_intent_id: pi.id,
        gift_message: giftMessage || '',
        sender_name: senderName,
      });
      if (purchaseError) {
        if (purchaseError.code === '23505') {
          console.log('Duplicate payment_intent, skipping:', pi.id);
          res.sendStatus(200); return;
        }
        throw purchaseError;
      }
      const token = crypto.randomUUID();
      const baseUrl = process.env.BASE_URL;
      await supabase.from('tokens').insert({
        token,
        product_id: productId,
        product_name: product?.name || '',
        amount: pi.amount,
        status: 'unused',
        line_user_id: lineUserId,
        gift_message: giftMessage || '',
        payment_intent_id: pi.id,
        sender_name: senderName,
      });
      await supabase.from('funnel_events').insert({ user_id: lineUserId, event_type: 'payment_complete', product_id: productId });
      const giftUrl = `${baseUrl}/gift/redeem?token=${token}`;
      await lineClient.pushMessage({
        to: lineUserId,
        messages: [buildGiftFlex(product?.name || '', giftUrl)],
      });
      console.log(`Gift URL sent to ${lineUserId}: ${giftUrl}`);
    } catch (err) {
      console.error('Webhook processing error:', err);
    }
  }
  res.sendStatus(200);
});
module.exports = app;
module.exports.config = { api: { bodyParser: false } };