// Workers から転送された LINE イベントの受付

/**
 * Web アプリの POST 受付。
 * GAS では任意の HTTP ヘッダーを読めないため、認証情報は本文の JSON（転送データ）で受け取る。
 * GAS の Web アプリは HTTP ステータスを指定できないので、結果は JSON の ok で返す。
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20 * 1000)) {
    console.error('ロックを取得できませんでした');
    return jsonOutput_({ ok: false, error: 'busy' });
  }
  try {
    let linePayload;
    try {
      linePayload = verifyEnvelope_(e);
    } catch (err) {
      console.warn(`転送データを拒否しました: ${err.message}`);
      return jsonOutput_({ ok: false, error: 'unauthorized' });
    }

    const allowedUserId = getRequiredProperty_(PROP.ALLOWED_USER_ID);
    const events = Array.isArray(linePayload.events) ? linePayload.events : [];
    events.forEach(function (event) {
      // Workers でも絞り込んでいるが、GAS 側でも念のため確認する
      const source = event && event.source;
      if (!source || source.type !== 'user' || source.userId !== allowedUserId) {
        appendLog_(event && event.webhookEventId, event && event.type, '送信元チェック', '拒否', '許可されていない送信元');
        return;
      }
      handleEventOnce_(event);
    });
    return jsonOutput_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

/** 動作確認用。ブラウザで Web アプリの URL を開くと表示される */
function doGet() {
  return ContentService.createTextOutput(`${APP_NAME}: 稼働中`);
}

/**
 * 転送データを検証し、LINE の Webhook 本文（オブジェクト）を返す。
 * 署名: "v.ts.nonce.body" を共有シークレットで HMAC-SHA256 → Base64
 */
function verifyEnvelope_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('本文がありません');
  }

  let envelope;
  try {
    envelope = JSON.parse(e.postData.contents);
  } catch (err) {
    throw new Error('JSON ではありません');
  }
  if (!envelope || envelope.v !== 1 || typeof envelope.ts !== 'number' ||
      typeof envelope.nonce !== 'string' || envelope.nonce.length === 0 || envelope.nonce.length > 64 ||
      typeof envelope.body !== 'string' || typeof envelope.sig !== 'string') {
    throw new Error('形式が正しくありません');
  }

  const secret = getRequiredProperty_(PROP.SHARED_SECRET);
  const expected = hmacSha256Base64_(`${envelope.v}.${envelope.ts}.${envelope.nonce}.${envelope.body}`, secret);
  if (!timingSafeEqual_(expected, envelope.sig)) {
    throw new Error('署名が一致しません');
  }
  if (Math.abs(Date.now() - envelope.ts) > ENVELOPE_MAX_AGE_MS) {
    throw new Error('有効期限切れです');
  }

  const cache = CacheService.getScriptCache();
  const nonceKey = `nonce:${envelope.nonce}`;
  if (cache.get(nonceKey)) {
    throw new Error('再送されたデータです');
  }
  cache.put(nonceKey, '1', NONCE_CACHE_SECONDS);

  return JSON.parse(envelope.body);
}

/** 同じ webhookEventId のイベントを 2 回処理しない */
function handleEventOnce_(event) {
  const eventId = event.webhookEventId || '';
  if (eventId && isEventProcessed_(eventId)) {
    console.log(`処理済みのイベントのため無視しました: ${eventId}`);
    return;
  }

  let action = '';
  let result = '成功';
  let detail = '';
  // エラーの返信と処理履歴に同じ日時を出し、履歴の行を探しやすくする
  const loggedAt = formatNow_();
  try {
    action = routeEvent_(event);
  } catch (err) {
    result = 'エラー';
    detail = String(err && err.message ? err.message : err).slice(0, 500);
    console.error(err && err.stack ? err.stack : err);
    replyErrorQuietly_(event, loggedAt);
  }

  if (eventId) {
    CacheService.getScriptCache().put(`event:${eventId}`, '1', EVENT_ID_CACHE_SECONDS);
  }
  appendLog_(eventId, event.type, action, result, detail, loggedAt);
}

// 返信前にエラーになったときだけ届く（返信済みなら返信トークンが使用済みで失敗するが、無視してよい）
function replyErrorQuietly_(event, loggedAt) {
  if (!event.replyToken) return;
  try {
    replyMessages_(event.replyToken, [textMessage_(msgUnexpectedError_(loggedAt))]);
  } catch (err) {
    console.warn(`エラーの通知も送れませんでした: ${err.message}`);
  }
}

function isEventProcessed_(eventId) {
  if (CacheService.getScriptCache().get(`event:${eventId}`)) {
    return true;
  }
  // キャッシュが消えていても、処理履歴シートで確認する
  const sheet = getSheet_(SHEET_DEFS.LOGS);
  const col = getColumnIndex_(sheet, 'イベントID');
  if (sheet.getLastRow() < 2) return false;
  return sheet.getRange(2, col, sheet.getLastRow() - 1, 1)
    .createTextFinder(eventId)
    .matchEntireCell(true)
    .findNext() !== null;
}

function appendLog_(eventId, eventType, action, result, detail, loggedAt) {
  appendRowObject_(SHEET_DEFS.LOGS, {
    '日時': loggedAt || formatNow_(),
    'イベントID': eventId || '',
    'イベント種別': eventType || '',
    '操作': action || '',
    '結果': result || '',
    '詳細': detail || '',
  });
}

function hmacSha256Base64_(message, secret) {
  const bytes = Utilities.computeHmacSha256Signature(message, secret, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

// 比較にかかる時間から署名を推測されないよう、常に全文字を比較する
function timingSafeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
