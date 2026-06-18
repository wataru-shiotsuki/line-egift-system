function buildGiftFlex(productName, giftUrl) {
  const shareText = `🎁 ギフトが届きました！\n以下のURLを開いてギフトを受け取ってください。\n\n${giftUrl}`;
  return {
    type: 'flex', altText: `🎁 ${productName}のギフト準備ができました！`,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#00C300', paddingAll: '16px',
        contents: [{ type: 'text', text: '🎁 ギフト準備完了', color: '#ffffff', weight: 'bold', size: 'lg' }] },
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', contents: [
        { type: 'text', text: productName, weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: '贈りたい相手にギフトを送りましょう', size: 'sm', color: '#666666', margin: 'md', wrap: true },
      ]},
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: [{
        type: 'button', style: 'primary', color: '#00C300',
        action: { type: 'uri', label: '💌 友だちにギフトを送る', uri: `https://line.me/R/msg/text/?${encodeURIComponent(shareText)}` },
      }]},
    },
  };
}
function buildClaimedFlex(productName) {
  return {
    type: 'flex', altText: 'ギフトが受け取られました！',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#4CAF50', paddingAll: '16px',
        contents: [{ type: 'text', text: '✅ ギフト受け取り完了', color: '#ffffff', weight: 'bold', size: 'lg' }] },
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', contents: [
        { type: 'text', text: `「${productName}」が受け取られました`, size: 'md', wrap: true },
        { type: 'text', text: '喜んでもらえるといいですね🎉', size: 'sm', color: '#666666', margin: 'md' },
      ]},
    },
  };
}
function buildSelectFlex(liffUri) {
  return {
    type: 'flex', altText: 'ギフト選択ページを開く',
    contents: {
      type: 'bubble', size: 'kilo',
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', contents: [
        { type: 'text', text: 'ギフト選択ページを開く', weight: 'bold', size: 'sm', color: '#333333' },
      ]},
      footer: { type: 'box', layout: 'vertical', paddingAll: '10px', paddingTop: '0px', contents: [{
        type: 'button', style: 'primary', color: '#00C300', height: 'sm',
        action: { type: 'uri', label: '🎁 ギフトを選ぶ', uri: liffUri },
      }]},
    },
  };
}
module.exports = { buildGiftFlex, buildClaimedFlex, buildSelectFlex };