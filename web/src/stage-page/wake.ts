// 호출어: "아로나, 오늘 날씨 어때?" 처럼 이름으로 시작하는 말만 받음 (계속 듣기). ming-voice 의 wake word 를 본뜸.
// Whisper 가 이름을 조금 다르게 적어도("아론아", "아로나야") 받게, 한글은 자모로 풀어서 비교함

// 한글 음절을 자모로 풀어서 비교 (아론아 → ㅇㅏㄹㅗㄴㅇㅏ, 아로나 → ㅇㅏㄹㅗㄴㅏ: 한 글자 차이).
// NFD 는 받침 ㄴ 과 첫소리 ㄴ 을 다른 글자로 풀어서, 같은 호환 자모로 직접 풂
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONG = ['', ...'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ'];
const jamo = (s: string) =>
  [...s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')]
    .map((c) => {
      const i = c.charCodeAt(0) - 0xac00;
      return i >= 0 && i < 11172 ? CHO[Math.floor(i / 588)] + JUNG[Math.floor((i % 588) / 28)] + JONG[i % 28] : c;
    })
    .join('');

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

const GREETING = /^(헤이|hey|저기|야|어이)$/i;
const CALL_SUFFIX = /(야|아|씨|님|짱)$/; // 아로나야, 아로나 씨

// 이름으로 시작하면 이름 뒤의 말(없으면 ''), 아니면 null
export function stripWake(text: string, word: string): string | null {
  const target = jamo(word);
  if (!target) return text.trim();
  const tol = Math.max(1, Math.floor(target.length / 4));
  const words = text.trim().split(/\s+/);
  if (words.length > 1 && GREETING.test(words[0].replace(/[\p{P}]/gu, ''))) words.shift();
  const near = (s: string) => distance(jamo(s), target) <= tol;
  // 첫 단어, 부르는 말 붙은 것(아로나야), Whisper 가 띄어 쓴 것(아 로나)
  const head = words[0] ?? '';
  const bare = head.replace(/[\p{P}]+$/u, '');
  if (near(bare) || near(bare.replace(CALL_SUFFIX, ''))) return clean(words.slice(1).join(' '));
  if (words.length > 1 && near(bare + words[1].replace(/[\p{P}]+$/u, ''))) return clean(words.slice(2).join(' '));
  return null;
}

// 띄어 쓴 부르는 말(아로나 씨, 아로나 님)과 앞 문장부호는 뗌
const clean = (rest: string) =>
  rest
    .replace(/^[\s,.!?~…]+/u, '')
    .replace(/^(씨|님|야)(?=[\s,.!?~…]|$)[\s,.!?~…]*/u, '')
    .trim();
