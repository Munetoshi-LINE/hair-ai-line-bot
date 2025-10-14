// ====== index.js (ベースコード) ======
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

// ====== LINE設定 ======
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'DUMMY',
  channelSecret: process.env.LINE_CHANNEL_SECRET || 'DUMMY',
};

const client = new line.Client(config);

// ====== Webhook設定 ======
app.post('/webhook', line.middleware(config), async (req, res) => {
  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

// ====== イベント処理 ======
async function handleEvent(event) {
  if (event.type !== 'message') return;

  if (event.message.type === 'text') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'こんにちは！自撮りを送ってね📸',
    });
  }
}

// ====== ヘルスチェック ======
app.get('/health', (_req, res) => res.send('ok'));

// ====== サーバー起動 ======
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Server running on port ${port}`));
