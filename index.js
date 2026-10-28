// LINE Webhook の受付窓口（Cloudflare Workers）
// 1. LINE署名を生の本文で検証
// 2. 許可した自分のLINEユーザーID以外のイベントを除外
// 3. 認証情報を付けて GAS Web アプリへ転送（返信は GAS が行う）

import { buildGasEnvelope, filterAllowedEvents, verifyLineSignature } from './lib.js';

const WEBHOOK_PATH = '/webhook';
const MAX_BODY_BYTES = 1024 * 1024;
const GAS_TIMEOUT_MS = 25_000; // waitUntil の上限（30秒）より短くする

const REQUIRED_SECRETS = [
  'LINE_CHANNEL_SECRET',
  'LINE_ALLOWED_USER_ID',
  'GAS_WEBAPP_URL',
  'GAS_SHARED_SECRET',
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== WEBHOOK_PATH) {
      return new Response('Not Found', { status: 404 });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
    }

    const missing = REQUIRED_SECRETS.filter((name) => !env[name]);
    if (missing.length > 0) {
      console.error(`Secrets が未設定です: ${missing.join(', ')}`);
      return new Response('Server Misconfigured', { status: 500 });
    }

    const declaredLength = Number(request.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_BODY_BYTES) {
      return new Response('Payload Too Large', { status: 413 });
    }

    // 解析前の生のバイト列で署名を検証する
    const rawBody = new Uint8Array(await request.arrayBuffer());
    if (rawBody.byteLength > MAX_BODY_BYTES) {
      return new Response('Payload Too Large', { status: 413 });
    }
    const signature = request.headers.get('x-line-signature');
    const valid = await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET);
    if (!valid) {
      console.warn('LINE署名の検証に失敗しました');
      return new Response('Unauthorized', { status: 401 });
    }

    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    const { allowed, rejectedCount } = filterAllowedEvents(payload, env.LINE_ALLOWED_USER_ID);
    if (rejectedCount > 0) {
      console.warn(`許可されていない送信元のイベントを ${rejectedCount} 件無視しました`);
    }

    // LINEにはすぐ200を返し、GASへの転送は応答後に行う（LINE推奨の非同期処理）
    // 「検証」ボタンのイベントが空のリクエストは転送しない
    if (allowed.length > 0) {
      ctx.waitUntil(forwardToGas(env, { destination: payload.destination, events: allowed }));
    }
    return new Response('OK', { status: 200 });
  },
};

async function forwardToGas(env, linePayload) {
  try {
    const envelope = await buildGasEnvelope(JSON.stringify(linePayload), env.GAS_SHARED_SECRET);
    // GAS Web アプリは 302 で結果の URL へ転送するため、リダイレクトを追う（既定動作）
    const res = await fetch(env.GAS_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
      redirect: 'follow',
      signal: AbortSignal.timeout(GAS_TIMEOUT_MS),
    });
    const text = await res.text();
    let result = null;
    try {
      result = JSON.parse(text);
    } catch {
      // GAS がエラーページ（HTML）を返した場合
    }
    if (!res.ok || result?.ok !== true) {
      console.error(`GASへの転送が失敗しました: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
  } catch (err) {
    console.error('GASへの転送中にエラーが発生しました', err);
  }
}
