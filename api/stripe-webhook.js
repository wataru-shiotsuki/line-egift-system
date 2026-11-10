const express = require('express');
const Stripe = require('stripe');
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const lineClient = require('../lib/line');
const { getActiveProducts } = require('../lib/products');
const { buildGiftFlex } = require('../lib/flex');
const genAI = require('../lib/gemini');

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
        const paymentMethodType = pi.payment_method_types?.[0] || 'card';
        const { data: giftRow } = await supabase.from('gifts')
          .update({ status: 'paid', stripe_payment_intent_id: pi.id, payment_method_type: paymentMethodType })
          .eq('gift_id', giftId)
          .select('items, sender_name, occasion_text, presentation_style, comment_variant')
          .maybeSingle();


        if (giftRow?.comment_variant === 'ai_generated') {
          try {
            const items = Array.isArray(giftRow.items) ? giftRow.items : [];
            const itemNames = items.map(i => i.name).join('・');
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
            const prompt = `あなたはギフトを贈る人をサポートするアシスタントです。
以下の情報をもとに、受取人にギフトURLを送るときに添えるひとことメッセージを生成してください。
・贈り手の名前: ${giftRow.sender_name || ''}
・ギフト内容: ${itemNames}
・シーン・メッセージ: ${giftRow.occasion_text || ''}
・プレゼンスタイル: ${giftRow.presentation_style || 'celebrate'}

条件:
- 40〜80文字程度
- 温かみのある自然な日本語
- マークダウン・絵文字なし
- 例: 「いつもありがとう。気に入ってくれると嬉しいです」`;
            const result = await model.generateContent(prompt);
            const aiComment = result.response.text().trim().slice(0, 100);
            await supabase.from('gifts').update({ ai_share_comment: aiComment }).eq('gift_id', giftId);
          } catch (aiErr) {
            console.error('[Giftalk] AI comment generation error:', aiErr);
          }
        }


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
          const liffUrl = `https://liff.line.me/${process.env.LIFF_ID}`;
          await lineClient.pushMessage({
            to: lineUserId,
            messages: [{
              type: 'flex',
              altText: '🎁 決済完了！LIFFアプリで受取人に送ってください',
              contents: {
                type: 'bubble',
                body: {
                  type: 'box',
                  layout: 'vertical',
                  spacing: 'md',
                  contents: [
                    { type: 'text', text: '🎁 決済完了！', weight: 'bold', size: 'lg', color: '#00C300' },
                    { type: 'text', text: 'LIFFアプリで受取人にギフトを送ってください。', wrap: true, size: 'sm', color: '#333333' },
                    { type: 'text', text: '送れなかった場合は下のボタンからもう一度開くと続きから送れます。', wrap: true, size: 'xs', color: '#888888', margin: 'sm' },
                  ],
                },
                footer: {
                  type: 'box',
                  layout: 'vertical',
                  contents: [{
                    type: 'button',
                    style: 'primary',
                    color: '#00C300',
                    action: { type: 'uri', label: 'ギフトを送る', uri: liffUrl },
                  }],
                },
              },
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
