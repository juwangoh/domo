'use strict';
const path = require('node:path');
const { Auth } = require('../src/auth');

const pw = process.argv[2];
if (!pw || pw.length < 4) {
  console.error('사용법: npm run password -- 새비밀번호   (4자 이상)');
  process.exit(1);
}
new Auth(path.join(__dirname, '..', 'data')).setPassword(pw);
console.log('비밀번호를 바꿨습니다. 모든 기기는 다시 로그인해야 합니다. (서버 재시작 필요)');
