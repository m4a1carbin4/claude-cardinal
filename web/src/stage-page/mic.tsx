import { createRoot } from 'react-dom/client';
import { MicInput } from '../components/MicInput';

// 메인 화면 대화 탭과 같은 음성 입력 (브라우저 안 Whisper). 모델·언어·바로 보내기 설정도 같이 씀 (localStorage cardinal.asr)
export function mountMic(host: HTMLElement, onText: (text: string, autoSend: boolean) => void): void {
  createRoot(host).render(<MicInput onText={onText} />);
}
