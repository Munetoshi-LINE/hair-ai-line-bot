// ===== index.js (CommonJS) =====
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');


// ✅ Node.js v18未満対策：fetchを動作保証
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
// ===== 環境変数 =====
const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  GEMINI_API_KEY,
  BASE_URL,
  PORT = 10000,
} = process.env;

// Render環境でBASE_URLが未設定の場合、自動生成
const PUBLIC_BASE_URL = BASE_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost:' + PORT}`;

// ===== LINE 設定 =====
const config = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// ===== Express =====
const app = express();
// ===== Webhook受信（署名検証つき）=====
app.post(
  '/webhook',
  express.raw({ type: '*/*' }), // ←ここ重要
  (req, res, next) => {
    try {
      const signature = req.get('x-line-signature');
      if (!line.validateSignature(req.body, LINE_CHANNEL_SECRET, signature)) {
        console.error('❌ Invalid signature');
        return res.status(403).send('Invalid signature');
      }
      // 検証OK → JSON化してイベント処理へ
      req.body = JSON.parse(req.body.toString());
      next();
    } catch (err) {
      console.error('Signature validation error:', err);
      return res.status(500).send('Signature error');
    }
  },
  async (req, res) => {
    Promise.all(req.body.events.map(handleEvent)).catch(console.error);
    res.status(200).end();
  }
);

// 生成画像の一時公開用 (Renderの一時FS)
// /tmp はサーバ再起動で消える想定。MVPではこれでOK。
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);
app.use('/tmp', express.static(TMP_DIR, { maxAge: '1h' }));

// ヘルスチェック
app.get('/', (_, res) => res.status(200).send('OK'));
app.post('/webhook', line.middleware(config), async (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).catch(console.error);
  res.status(200).end();
});

// ===== In-Memory 状態管理（MVP） =====
const userState = Object.create(null);

// ===== 共通ユーティリティ =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function reply(token, message) {
  for (let i = 0; i < 3; i++) {
    try { return await client.replyMessage(token, message); }
    catch (e) { if (i === 2) throw e; await sleep(250 * (i + 1)); }
  }
}

async function push(userId, message) {
  for (let i = 0; i < 3; i++) {
    try { return await client.pushMessage(userId, message); }
    catch (e) { if (i === 2) throw e; await sleep(250 * (i + 1)); }
  }
}

function quickReply(items) {
  return {
    items: items.map(t => ({
      type: 'action',
      action: { type: 'message', label: t, text: t }
    }))
  };
}

// 画像の最適前処理（プロ仕様）
async function preprocessImage(buffer) {
  return sharp(buffer)
    .resize({ width: 720, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .withMetadata(false)
    .toBuffer();
}

// 画像を /tmp に保存し公開URLを返す
async function saveTempImage(b64, userId, prefix = 'gen') {
  const filename = `${prefix}_${userId}_${Date.now()}.jpg`;
  const filePath = path.join(TMP_DIR, filename);
  await fs.promises.writeFile(filePath, Buffer.from(b64, 'base64'));
  return `${PUBLIC_BASE_URL}/tmp/${filename}`;
}

// LINE CDN から画像を取得→Buffer
async function getImageBuffer(messageId) {
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ===== Gemini 画像合成呼び出し =====
async function callGeminiImageCompose({ faceB64, modelB64, style, color }) {
  const prompt = [
    'ユーザーの顔写真をベースに、モデル写真の髪型を自然に合成してください。',
    style ? `髪型のカテゴリは「${style}」です。` : '',
    color ? `髪色は「${color}」で仕上げてください。` : '髪色は顔写真のままでもOKです。',
    '背景は残し、全体のトーンは明るめで自然に整えてください。',
    '出力は縦構図（3:4）で、スマホ向けに見やすく生成してください。'
  ].join(' ');

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent';

  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: 'image/jpeg', data: faceB64 } },
        ...(modelB64 ? [{ inline_data: { mime_type: 'image/jpeg', data: modelB64 } }] : []),
        { text: prompt }
      ]
    }]
    // ❌ generationConfig は削除（テキストモデル専用）
  };

  const resp = await fetch(`${url}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`[Gemini API Error] Status: ${resp.status}\n${errText}`);
    throw new Error(`Gemini API error ${resp.status}`);
  }

  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inline_data?.data);
  if (!imagePart) {
    console.error('[Gemini response parse error]', JSON.stringify(data, null, 2));
    throw new Error('No image data returned from Gemini.');
  }
  return imagePart.inline_data.data;
}



// ===== QuickReply 定義 =====
const STYLE_QR = ['ショート', 'ボブ', 'ミディアム', 'ロング', 'ウルフ', 'メンズ', 'モデル写真を送る📸', '自由入力✍️'];
const COLOR_QR = ['そのまま', '黒髪', 'ミルクティー', 'ピンクベージュ', 'グレージュ', '自由入力✍️'];

// ===== メインハンドラ =====
async function handleEvent(event) {
  const userId = event.source.userId;
  userState[userId] ||= { step: 'await_face', faceB64: null, style: null, color: null };

  if (event.type === 'message') {
    const m = event.message;

    // 画像
    if (m.type === 'image') {
      const buf = await getImageBuffer(m.id);
      const pre = await preprocessImage(buf);
      const b64 = pre.toString('base64');
      const st = userState[userId];

      if (st.step === 'await_face' || !st.faceB64) {
        st.faceB64 = b64;
        st.step = 'await_style';
        return reply(event.replyToken, {
          type: 'text',
          text: 'ナイスショット👌 どんな髪型を試してみる？（参考写真を送ってもOK）',
          quickReply: quickReply(STYLE_QR)
        });
      } else if (st.step === 'await_model_image') {
        st.modelB64 = b64;
        st.step = 'await_color';
        return reply(event.replyToken, {
          type: 'text',
          text: 'モデル髪型の写真を受け取ったよ！ 髪色も変えてみる？🎨',
          quickReply: quickReply(COLOR_QR)
        });
      } else {
        st.faceB64 = b64;
        st.step = 'await_style';
        return reply(event.replyToken, {
          type: 'text',
          text: '自撮りを更新したよ。次は髪型を選んでね✂️',
          quickReply: quickReply(STYLE_QR)
        });
      }
    }

    // テキスト
    if (m.type === 'text') {
      const txt = (m.text || '').trim();
      if (/^(こんにちは|こんちは|やあ|hi|hello)$/i.test(txt)) {
        userState[userId] = { step: 'await_face', faceB64: null, style: null, color: null };
        return reply(event.replyToken, { type: 'text', text: 'こんにちは！まずは自撮りを送ってください📸' });
      }

      const st = userState[userId];

      if (/モデル写真/.test(txt)) {
        st.step = 'await_model_image';
        return reply(event.replyToken, { type: 'text', text: '参考にしたい髪型の写真を送ってください📸（正面・明るめ推奨）' });
      }

      const isStylePick = STYLE_QR.includes(txt) && txt !== 'モデル写真を送る📸' && txt !== '自由入力✍️';
      const isColorPick = COLOR_QR.includes(txt) && txt !== '自由入力✍️';

      if (txt === '自由入力✍️') {
        if (st.step === 'await_style' || !st.style) {
          st.step = 'await_style';
          return reply(event.replyToken, { type: 'text', text: 'なりたい髪型をテキストで教えてください（例：くびれボブ、ハンサムショート 等）' });
        } else {
          st.step = 'await_color';
          return reply(event.replyToken, { type: 'text', text: '髪色をテキストで教えてください（例：ピンクベージュ、ブルーブラック 等）' });
        }
      }

      if (st.step === 'await_style') {
        st.style = isStylePick ? txt : txt;
        st.step = 'await_color';
        return reply(event.replyToken, { type: 'text', text: '髪色も変えてみる？🎨', quickReply: quickReply(COLOR_QR) });
      }

      if (st.step === 'await_color') {
        st.color = isColorPick ? (txt === 'そのまま' ? '' : txt) : txt;
        if (!st.faceB64) {
          st.step = 'await_face';
          return reply(event.replyToken, { type: 'text', text: '先に自撮りを送ってください📸' });
        }

        await reply(event.replyToken, { type: 'text', text: 'AIがスタイルを生成中です…⏳' });

        try {
          const imgB64 = await callGeminiImageCompose({
            faceB64: st.faceB64,
            modelB64: st.modelB64 || null,
            style: st.style,
            color: st.color
          });

          const url = await saveTempImage(imgB64, userId, 'hair');
          await push(userId, { type: 'image', originalContentUrl: url, previewImageUrl: url });
          await push(userId, { type: 'text', text: '完成！似合ってますね✨ もう一度試す？', quickReply: quickReply(['もう一度試す', '髪型を変える', '髪色だけ変える']) });

          st.step = 'await_style';
          st.modelB64 = null;
          st.color = null;
        } catch (err) {
          console.error('[GeminiError]', err);
          await push(userId, { type: 'text', text: 'ごめん、画像の生成に失敗しました。もう一度試してみてね🙏' });
        }
        return;
      }

      if (txt === 'もう一度試す') {
        userState[userId] = { step: 'await_style', faceB64: userState[userId]?.faceB64 || null, style: null, color: null, modelB64: null };
        return reply(event.replyToken, { type: 'text', text: 'OK！次の髪型を選んでね✂️', quickReply: quickReply(STYLE_QR) });
      }
      if (txt === '髪型を変える') {
        userState[userId].step = 'await_style';
        userState[userId].style = null;
        userState[userId].modelB64 = null;
        return reply(event.replyToken, { type: 'text', text: 'どの髪型にする？', quickReply: quickReply(STYLE_QR) });
      }
      if (txt === '髪色だけ変える') {
        userState[userId].step = 'await_color';
        return reply(event.replyToken, { type: 'text', text: '髪色を選んでね🎨', quickReply: quickReply(COLOR_QR) });
      }

      return reply(event.replyToken, { type: 'text', text: 'まずは自撮りを送ってください📸' });
    }
  }
  return Promise.resolve();
}

// ===== サーバ起動 =====
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Public URL: ${PUBLIC_BASE_URL}`);
});
