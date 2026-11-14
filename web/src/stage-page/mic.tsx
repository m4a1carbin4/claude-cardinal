import { createRoot } from 'react-dom/client';
import { StageVoice } from './voice';

export { setReplying } from './voice';

// 음성 입력 (브라우저 안 Whisper). 모델·언어·바로 보내기는 메인 화면 대화 탭과 같이 씀 (localStorage cardinal.asr),
// 듣는 방식(버튼 / 누르는 동안 / 계속 듣기, 호출어)은 스테이지만 (cardinal.stage.voice). onWake: 이름만 불렀을 때,
// onListen: 사람이 말하기 시작함 (녹음 시작·누름·계속 듣기에서 말소리 시작) → 캐릭터 말 끊기
export function mountMic(
  host: HTMLElement,
  onText: (text: string, send: boolean) => void,
  onWake?: () => void,
  onListen?: () => void,
): void {
  createRoot(host).render(<StageVoice onText={onText} onWake={onWake} onListen={onListen} />);
}
