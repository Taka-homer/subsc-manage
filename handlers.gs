// イベントの振り分けと返信内容

const HELP_KEYWORDS = ['ヘルプ', 'help', '使い方', '設定・使い方', '?', '？'];
const REGISTER_KEYWORD = '登録する';
const CANCEL_KEYWORD = 'キャンセル';
const LIST_KEYWORD = '契約一覧';
const THIS_MONTH_KEYWORD = '今月の支払い';
const UPCOMING_KEYWORD = '次の支払い';
const MANAGE_KEYWORD = '変更・解約';

/** イベントを処理し、処理履歴に残す「操作」の名前を返す */
function routeEvent_(event) {
  const userId = event.source.userId;
  switch (event.type) {
    case 'message':
      if (event.message && event.message.type === 'text') {
        return handleText_(event, userId);
      }
      replyMessages_(event.replyToken, [textMessage_(`文字で送ってください。${msgHelpHint_()}`)]);
      return 'テキスト以外';
    case 'postback':
      return handlePostback_(event, userId);
    case 'follow':
      // 友だち追加（ブロック解除）したとき
      replyMessages_(event.replyToken, [buildHelpMessage_()]);
      return '友だち追加→ヘルプ';
    default:
      // unfollow など返信できない・不要なイベント
      return '対象外';
  }
}

function handleText_(event, userId) {
  const text = normalizeText_(event.message.text);
  const session = getSession_(userId);
  const active = session && !session.expired ? session : null;
  if (session && session.expired) {
    clearSession_(userId);
  }

  if (matchesKeyword_(text, [REGISTER_KEYWORD])) {
    return startRegistration_(event, userId, active);
  }
  if (matchesKeyword_(text, HELP_KEYWORDS)) {
    replyMessages_(event.replyToken, [buildHelpMessage_()].concat(resumeMessages_(active)));
    return 'ヘルプ';
  }
  if (matchesKeyword_(text, [LIST_KEYWORD])) {
    replyMessages_(event.replyToken, contractListMessages_(false).concat(resumeMessages_(active)));
    return '契約一覧';
  }
  if (matchesKeyword_(text, [THIS_MONTH_KEYWORD])) {
    const today = todayYmd_();
    replyMessages_(event.replyToken, monthMessages_(today.y, today.m).concat(resumeMessages_(active)));
    return '今月の支払い';
  }
  if (matchesKeyword_(text, [UPCOMING_KEYWORD])) {
    replyMessages_(event.replyToken, upcomingMessages_().concat(resumeMessages_(active)));
    return '次の支払い';
  }
  if (matchesKeyword_(text, [MANAGE_KEYWORD])) {
    replyMessages_(event.replyToken, contractListMessages_(false, true).concat(resumeMessages_(active)));
    return '変更・解約（契約の選択）';
  }
  if (matchesKeyword_(text, [CANCEL_KEYWORD])) {
    if (active) return cancelFlow_(event, active);
    replyMessages_(event.replyToken, [textMessage_('キャンセルする操作はありません。')]);
    return 'キャンセル（操作なし）';
  }
  if (active) {
    return isDraftFlow_(active.flow)
      ? handleRegistrationText_(event, active, event.message.text)
      : handleManageText_(event, active, event.message.text);
  }
  if (session && session.expired) {
    replyMessages_(event.replyToken, [textMessage_(msgExpired_())]);
    return '期限切れ';
  }
  // メニューにない文章は AI で読み取る（AI が未設定なら使い方を案内する）
  return handleFreeText_(event, userId, event.message.text);
}

function handlePostback_(event, userId) {
  const data = parsePostbackData_(event.postback && event.postback.data);

  // 表示だけのボタンは操作状態と関係なく使える（操作の途中でも下書きはそのまま）
  const viewOperation = handleViewPostback_(event, data);
  if (viewOperation) return viewOperation;

  // 詳細画面の［変更する］［解約する］などは、契約の版で古いボタンかどうかを判定する
  const startOperation = handleManageStartPostback_(event, userId, data);
  if (startOperation) return startOperation;

  if (isTokenDone_(data.t)) {
    replyMessages_(event.replyToken, [textMessage_('✅ この操作はすでに完了しています。')]);
    return '完了済みのボタン';
  }
  const session = getSession_(userId);
  if (!session || !data.t || session.token !== data.t) {
    replyMessages_(event.replyToken, [textMessage_(msgStaleButton_())]);
    return '古いボタン';
  }
  if (session.expired) {
    clearSession_(userId);
    replyMessages_(event.replyToken, [textMessage_(msgExpired_())]);
    return '期限切れ';
  }
  if (isDraftFlow_(session.flow)) {
    return handleRegistrationPostback_(event, session, data);
  }
  if (isStatusFlow_(session.flow)) {
    return handleManagePostback_(event, session, data);
  }
  replyMessages_(event.replyToken, [textMessage_(msgStaleButton_())]);
  return '不明な操作のボタン';
}

/** 一覧・詳細・月の切り替えのボタン。対象外なら null */
function handleViewPostback_(event, data) {
  switch (data.a) {
    case 'list':
      replyMessages_(event.replyToken, contractListMessages_(data.s === 'c'));
      return data.s === 'c' ? '契約一覧（解約済み）' : '契約一覧';
    case 'detail':
      replyMessages_(event.replyToken, contractDetailMessages_(String(data.id || '')));
      return '契約詳細';
    case 'month': {
      const ym = parseYearMonth_(data.ym);
      if (!ym) {
        replyMessages_(event.replyToken, [textMessage_('表示できない年月です。')]);
        return '月の支払い（不正な年月）';
      }
      replyMessages_(event.replyToken, monthMessages_(ym.y, ym.m));
      return `月の支払い: ${data.ym}`;
    }
    default:
      return null;
  }
}

/** どの操作でも「キャンセル」で中止する */
function cancelFlow_(event, session) {
  clearSession_(session.userId);
  const message = session.flow === FLOW.REGISTER
    ? 'キャンセルしました。登録内容は保存していません。'
    : `${session.flow}を取りやめました。契約の内容は変わっていません。`;
  replyMessages_(event.replyToken, [textMessage_(message)]);
  return `${session.flow}: キャンセル`;
}

/** 操作の途中なら、続きの案内を付け足す */
function resumeMessages_(session) {
  if (!session) return [];
  return [textMessage_(`📝 ${session.flow}の途中です。続けるか「キャンセル」を選んでください。`), promptFor_(session)];
}

function matchesKeyword_(normalizedText, keywords) {
  return keywords.map(normalizeText_).indexOf(normalizedText) !== -1;
}

function buildHelpMessage_() {
  const lines = [
    `📋 ${APP_NAME}の使い方`,
    '',
    '画面下のメニューから操作します。',
    '・登録する：新しい契約を登録',
    '・契約一覧：登録済みの契約と詳細',
    '・今月の支払い：今月の支払予定と合計',
    '・次の支払い：直近の支払予定',
    '・変更・解約：内容の変更、解約、削除',
    '・設定・使い方：この案内を表示',
    '',
    '登録は質問に答えていく形で進み、最後に内容を確認してから保存します。途中で「キャンセル」と送ると中止できます。',
    '',
    '一覧や支払予定の行を押すと、その契約の詳細を表示します。詳細の下のボタンから、変更・解約・削除ができます。',
    '・解約：解約日より後の支払いが予定から外れます（記録は残ります）',
    '・削除：契約を完全に消します（元に戻せません）',
    '',
    '年払いの契約は、月額換算（12で割った額）も表示します。',
  ];
  if (isAiEnabled_()) {
    lines.push(
      '',
      '🤖 文章でも操作できます（AIが読み取り、確認してから保存します）。',
      AI_EXAMPLES,
      '※ 送った文章は解析のため Google の Gemini API に送られます。');
  }
  return textMessage_(lines.join('\n'));
}
