export const ja = {
  'login.codeSent': '{email} に確認コードを送信しました。',
  'login.codeInvalid': '確認コードが正しくありません。',
  'age.under13': '13歳未満の方は利用できません。',
  'age.invalid': '生年月日が正しくありません。',
  'recovery.adminSubject': '[管理] 復旧申請があります',
  'recovery.adminBody': '復旧申請が届きました。申請 ID: {requestId}\n確認後、pnpm --filter api admin:approve-recovery {requestId} を実行してください。',
  'recovery.approvedSubject': '復旧申請が承認されました',
  'recovery.approvedBody': '復旧申請が承認されました。以前のログイン状態とパスキーはすべて無効になりました。メールアドレスでログインし、パスキーを設定し直してください。新しい復旧コードは管理者から別の方法でお渡しします。',
} as const;
