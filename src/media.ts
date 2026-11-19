import { log, errText } from './log';

export const VIDEO_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
];

export const AUDIO_MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

export function isTypeSupported(t: string): boolean {
  try { return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t); } catch { return false; }
}

export function supportedVideoMimes(): string[] {
  return VIDEO_MIME_CANDIDATES.filter(isTypeSupported);
}

// MP4 в приоритете: его без проблем открывают и iPhone, и Android, и мессенджеры.
export function pickVideoMime(): string {
  return supportedVideoMimes()[0] ?? '';
}

export function pickAudioMime(): string {
  return AUDIO_MIME_CANDIDATES.find(isTypeSupported) ?? '';
}

export function extForMime(mime: string): string {
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  return 'bin';
}

export interface MicSettings { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean }

export async function openCamera(mic: MicSettings): Promise<MediaStream> {
  if (!window.isSecureContext) throw new Error('Страница открыта не по HTTPS — браузер не даст доступ к камере и микрофону.');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia недоступен в этом браузере.');
  const s = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: { ...mic, channelCount: { ideal: 1 } },
  });
  for (const t of s.getTracks()) {
    log(`Трек ${t.kind}: "${t.label}" ${JSON.stringify(t.getSettings())}`);
  }
  return s;
}

export function explainGumError(e: unknown): string {
  const name = e instanceof DOMException || e instanceof Error ? e.name : '';
  switch (name) {
    case 'NotAllowedError':
      return 'Доступ к камере или микрофону запрещён. iPhone: Настройки → Safari → Камера/Микрофон → «Разрешить» (или «аА» в адресной строке → Настройки веб-сайта). Android Chrome: значок замка слева от адреса → Разрешения. Затем обновите страницу.';
    case 'NotFoundError':
      return 'Камера или микрофон не найдены.';
    case 'NotReadableError':
      return 'Камера или микрофон заняты другим приложением (звонок, другая вкладка, диктофон). Закройте его и попробуйте снова.';
    case 'OverconstrainedError':
      return 'Камера не поддерживает запрошенные параметры.';
    case 'SecurityError':
      return 'Браузер заблокировал доступ из соображений безопасности (нужен HTTPS).';
    default:
      return errText(e);
  }
}

export function speak(text: string, voiceName: string | null, volume = 1, rate = 1): { done: Promise<void>; stop: () => void } {
  if (!('speechSynthesis' in window)) {
    log('speechSynthesis недоступен', 'error');
    return { done: Promise.resolve(), stop: () => {} };
  }
  const synth = window.speechSynthesis;
  let finish: () => void = () => {};
  const done = new Promise<void>((res) => { finish = res; });
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ru-RU';
  u.volume = Math.max(0, Math.min(1, volume));
  u.rate = Math.max(0.5, Math.min(2, rate));
  const v = synth.getVoices().find((x) => x.name === voiceName) ?? synth.getVoices().find((x) => x.lang.toLowerCase().startsWith('ru'));
  if (v) u.voice = v;
  u.onstart = () => log(`TTS начал: "${text}" (${v?.name ?? 'голос по умолчанию'})`);
  u.onend = () => { log('TTS закончил'); finish(); };
  u.onerror = (e) => { log(`TTS ошибка: ${e.error}`, 'error'); finish(); };
  // Страховка: на части Android onend иногда не приходит.
  const timer = window.setTimeout(() => { log('TTS: onend не пришёл, завершаю по таймауту', 'warn'); finish(); }, 3000 + text.length * 150);
  done.then(() => clearTimeout(timer));
  synth.cancel();
  synth.speak(u);
  return { done, stop: () => { synth.cancel(); finish(); } };
}

export function playBuffer(ctx: AudioContext, buf: AudioBuffer, outputs: AudioNode[], rate = 1): { done: Promise<void>; stop: () => void } {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  outputs.forEach((o) => src.connect(o));
  let finish: () => void = () => {};
  const done = new Promise<void>((res) => { finish = res; });
  src.onended = () => { outputs.forEach((o) => { try { src.disconnect(o); } catch { /* уже отключён */ } }); finish(); };
  src.start();
  return { done, stop: () => { try { src.stop(); } catch { /* уже остановлен */ } } };
}
