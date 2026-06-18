const express = require('express');
const { validateSignature } = require('@line/bot-sdk');
const supabase = require('../lib/supabase');
const lineClient = require('../lib/line');
const genAI = require('../lib/gemini');
const { getActiveProducts } = require('../lib/products');
const { buildSelectFlex } = require('../lib/flex');
const app = express();
const RESET_KEYWORDS = ['リセット', 'やり直し', '最初から', 'reset', '新しく始める'];
const SHOW_GIFTS_KEYWORDS = ['一覧', '商品を見たい', '見せて', 'ギフト一覧', '商品一覧', 'ギフトを見る'];
const PURCHASE_HISTORY_KEYWORDS = ['購入履歴', '過去のギフト', '送った履歴', '履歴を見る'];
app.post('*', async (req, res) => {
  const rawBody = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  const sig = req.headers['x-line-signature'];
  const secret = (process.env.LINE_CHANNEL_SECRET || '').trim();
  if (!sig || !validateSignature(rawBody, secret, sig)) {
    console.error('LINE signature verification failed');
    return res.sendStatus(200);
  }
  const body = JSON.parse(rawBody.toString());
  for (const event of body.events || []) {
    const userId = event.source.userId;
    if (event.type === 'follow') {
      await lineClient.pushMessage({
        to: userId,
        messages: [
          { type: 'text', text: 'こんにちは！🎁\n\nプレゼント選びをお手伝いします。\n\nシーンや予算を教えてもらえれば、ぴったりのギフトを提案します。\n\nまずはどんなシーンか教えてください👇' },
        ],
      }).catch(err => console.error('follow push error:', err.message));
      continue;
    }
    if (event.type !== 'message' || event.message.type !== 'text') continue;
    const userMessage = event.message.text.trim();
    try {
      if (RESET_KEYWORDS.some(k => userMessage.includes(k))) {
        await supabase.from('chat_histories').delete().eq('user_id', userId);
        await lineClient.pushMessage({
          to: userId,
          messages: [
            { type: 'text', text: 'リセットしました！新しいギフト探しを始めましょう🎁\nどんなシーンか教えてください。' },
          ],
        });
        continue;
      }
      if (PURCHASE_HISTORY_KEYWORDS.some(k => userMessage.includes(k))) {
        const { data: rows } = await supabase.from('purchases').select('product_name, amount, timestamp, product_id').eq('user_id', userId).order('timestamp', { ascending: false }).limit(5);
        if (!rows || rows.length === 0) {
          await lineClient.pushMessage({
            to: userId,
            messages: [{ type: 'text', text: 'まだギフトの購入履歴がありません。' }],
          });
        } else {
          const bubbles = rows.map(p => ({
            type: 'bubble', size: 'micro',
            body: {
              type: 'box', layout: 'vertical', paddingAll: '14px', spacing: 'sm',
              contents: [
                { type: 'text', text: p.product_name, weight: 'bold', size: 'sm', wrap: true },
                { type: 'text', text: `¥${Number(p.amount).toLocaleString()}`, size: 'xs', color: '#00C300' },
                { type: 'text', text: new Date(p.timestamp).toLocaleDateString('ja-JP'), size: 'xxs', color: '#aaa' },
              ],
            },
            footer: {
              type: 'box', layout: 'vertical', paddingAll: '8px',
              contents: [{
                type: 'button', style: 'primary', color: '#00C300', height: 'sm',
                action: { type: 'uri', label: 'もう一度贈る', uri: `https://liff.line.me/2009924306-AGKLqoyb?product=${p.product_id}` },
              }],
            },
          }));
          await lineClient.pushMessage({
            to: userId,
            messages: [{ type: 'flex', altText: '📋 購入履歴（直近3件）', contents: { type: 'carousel', contents: bubbles } }],
          });
        }
        continue;
      }
      if (SHOW_GIFTS_KEYWORDS.some(k => userMessage.includes(k))) {
        await lineClient.pushMessage({
          to: userId,
          messages: [{ type: 'text', text: '商品一覧はこちらからどうぞ！\n\nシーンや予算を話しかけてもらえれば、AIがぴったりの商品を提案します🎁' }],
        });
        continue;
      }
      const allProducts = await getActiveProducts();
      const aiText = await callGemini(userId, userMessage, allProducts);
      const recIds = extractRecommendedIds(aiText, allProducts);
      const liffUri = recIds.length > 0
        ? `https://liff.line.me/2009924306-AGKLqoyb?rec=${recIds.join(',')}`
        : 'https://liff.line.me/2009924306-AGKLqoyb';
      const messages = recIds.length > 0
        ? [{ type: 'text', text: aiText }, buildSelectFlex(liffUri)]
        : [{ type: 'text', text: aiText }];
      await lineClient.pushMessage({ to: userId, messages });
      await saveConversationLog(userId, userMessage, aiText);
    } catch (err) {
      console.error('LINE event handling error:', err.message);
    }
  }
  res.sendStatus(200);
});
function extractRecommendedIds(aiText, allProducts) {
  return Object.entries(allProducts)
    .filter(([, p]) => aiText.includes(p.name))
    .map(([id]) => id);
}
async function callGemini(userId, userMessage, allProducts) {
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
「ギフトを選ぶ」などのボタン案内はしないでください。
【取り扱い商品リスト】
${Object.values(allProducts).map(p => `・${p.name}（${p.amount}円） - ${p.description}`).join('\n')}
自然な日本語で短めに返答してください。`,
  });
  const { data: row } = await supabase.from('chat_histories').select('history').eq('user_id', userId).maybeSingle();
  let history = row?.history || [];
  if (history.length > 40) history = history.slice(-40);
  const chat = model.startChat({ history });
  const result = await chat.sendMessage(userMessage);
  const aiText = result.response.text().trim();
  history.push({ role: 'user', parts: [{ text: userMessage }] });
  history.push({ role: 'model', parts: [{ text: aiText }] });
  await supabase.from('chat_histories').upsert({ user_id: userId, history, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  return aiText;
}
async function saveConversationLog(userId, userMessage, aiResponse) {
  try {
    await supabase.from('conversation_logs').insert({ user_id: userId, user_message: userMessage, ai_response: aiResponse });
  } catch (err) {
    console.error('DB log error:', err);
  }
}
module.exports = app;
module.exports.config = { api: { bodyParser: false } };