const { messagingApi } = require('@line/bot-sdk');
const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});
module.exports = lineClient;