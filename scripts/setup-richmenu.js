#!/usr/bin/env node
require('dotenv').config();
const https = require('https');
const zlib = require('zlib');
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LIFF_URI = process.env.LIFF_URL || 'https://liff.line.me/2009924306-AGKLqoyb';
if (!TOKEN) {
  console.error('LINE_CHANNEL_ACCESS_TOKEN が .env に設定されていません');
  process.exit(1);
}
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, d])));
  return Buffer.concat([len, t, d, crc]);
}
function createTwoColorPNG(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const rowBytes = 1 + w * 3;
  const raw = Buffer.alloc(h * rowBytes, 0xFF); 
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
function lineAPI(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = https.request({
      hostname: 'api.line.me',
      path,
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': payload.length } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
function uploadImage(richMenuId, pngBuffer) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api-data.line.me',
      path: `/v2/bot/richmenu/${richMenuId}/content`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'image/png',
        'Content-Length': pngBuffer.length,
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(pngBuffer);
    req.end();
  });
}
async function main() {
  console.log('リッチメニューをセットアップします...\n');
  console.log('1. 既存のデフォルトリッチメニューを確認中...');
  const existing = await lineAPI('GET', '/v2/bot/user/all/richmenu');
  if (existing.status === 200 && existing.body.richMenuId) {
    const oldId = existing.body.richMenuId;
    await lineAPI('DELETE', `/v2/bot/richmenu/${oldId}`);
    console.log(`   削除しました: ${oldId}`);
  } else {
    console.log('   既存メニューなし');
  }
  console.log('2. リッチメニューを作成中...');
  const menuDef = {
    size: { width: 2500, height: 843 },
    selected: true,
    name: 'ギフトメニュー',
    chatBarText: 'メニュー',
    areas: [
      {
        bounds: { x: 0, y: 0, width: 2500, height: 843 },
        action: { type: 'uri', label: '🎁 商品を選ぶ', uri: LIFF_URI },
      },
    ],
  };
  const created = await lineAPI('POST', '/v2/bot/richmenu', menuDef);
  if (created.status !== 200) {
    console.error('作成失敗:', created.body);
    process.exit(1);
  }
  const richMenuId = created.body.richMenuId;
  console.log(`   作成完了: ${richMenuId}`);
  console.log('3. メニュー画像をアップロード中...');
  const png = createTwoColorPNG(2500, 843);
  const uploaded = await uploadImage(richMenuId, png);
  if (uploaded.status !== 200) {
    console.error('画像アップロード失敗:', uploaded.body);
    process.exit(1);
  }
  console.log('   アップロード完了');
  console.log('4. 全ユーザーのデフォルトメニューに設定中...');
  const setDefault = await lineAPI('POST', `/v2/bot/user/all/richmenu/${richMenuId}`);
  if (setDefault.status !== 200) {
    console.error('デフォルト設定失敗:', setDefault.body);
    process.exit(1);
  }
  console.log('   設定完了\n');
  console.log('✅ リッチメニューのセットアップが完了しました！');
  console.log('   チャット画面の下部に「🎁 商品を選ぶ」ボタンが表示されます。');
  console.log('   タップすると選択ページが開き、ページ内のAIチャットでおすすめを聞けます。');
  console.log('\n   ※ 画像は現在LINE緑のベタ塗りです。');
  console.log('   　 LINE Official Account Manager でデザインを変更できます。');
  console.log('   　 https://manager.line.biz/');
}
main().catch(err => { console.error('エラー:', err); process.exit(1); });