import { useCallback, useEffect, useRef, useState } from 'react';
import { log, errText, logAsText, useLog } from './log';
import { SCENE, PARTNER_INDEXES } from './scene';
import {
  openCamera, explainGumError, supportedVideoMimes, pickVideoMime, pickAudioMime, extForMime,
  speak, playBuffer, VIDEO_MIME_CANDIDATES, AUDIO_MIME_CANDIDATES, isTypeSupported,
} from './media';
import { saveClip, deleteClip, loadClips } from './clipStore';
import { prepareClip, lineIndexFromName } from './audioTools';
import { Recognizer, matchLine, speechRecognitionSupported, words } from './speech';

type AudioMode = 'speaker' | 'mix';
type PartnerSource = 'tts' | 'clips';
type Phase = 'idle' | 'opening' | 'ready' | 'recording' | 'done';
type AdvanceMode = 'manual' | 'speech' | 'vad' | 'timer';
type Turn = 'idle' | 'partner' | 'actor';

// Порог голоса считается от уровня фонового шума (он подстраивается сам), умноженного на чувствительность.
const SENS: Record<string, number> = { high: 2, mid: 3, low: 4.5 };

interface Settings {
  audioMode: AudioMode;
  partnerSource: PartnerSource;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  duckMic: boolean;
  autoFirstLine: boolean;
  mimeType: string; // '' = автовыбор
  voiceName: string;
  advanceMode: AdvanceMode;
  replyDelay: number; // секунды тишины после реплики актёра
  partnerVolume: number; // 0.1..1
  sensitivity: 'high' | 'mid' | 'low';
  mirror: boolean; // Петя подстраивается под темп и громкость актёра
}

const DEFAULTS: Settings = {
  audioMode: 'speaker', partnerSource: 'tts', echoCancellation: true, noiseSuppression: true,
  autoGainControl: true, duckMic: false, mirror: true, autoFirstLine: true, mimeType: '', voiceName: '',
  advanceMode: speechRecognitionSupported() ? 'speech' : 'vad', replyDelay: 1, partnerVolume: 0.6, sensitivity: 'high',
};

function loadSettings(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('chudosufler.settings') ?? '{}') }; } catch { return DEFAULTS; }
}

interface Result { url: string; blob: Blob; mime: string; name: string; duration?: number }

type Stopper = { stop: () => void } | null;

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string>('');
  const [cursor, setCursorState] = useState(0);
  const [lastPartner, setLastPartner] = useState<number | null>(null);
  const [partnerSpeaking, setPartnerSpeaking] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [clipBlobs, setClipBlobs] = useState<Record<number, Blob>>({});
  const [clipDur, setClipDur] = useState<Record<number, number>>({});
  const [recordingClip, setRecordingClip] = useState<number | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [micState, setMicState] = useState('нет доступа');
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [warning, setWarning] = useState('');
  const [turn, setTurnState] = useState<Turn>('idle');
  const [heard, setHeard] = useState('');
  const [matched, setMatched] = useState<boolean[]>([]);
  const [srFailed, setSrFailed] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  // Отдельный AudioContext только для «слуха»: синтез речи на iPhone не должен его ломать.
  const micCtxRef = useRef<AudioContext | null>(null);
  const micSrcRef = useRef<{ node: MediaStreamAudioSourceNode; track: MediaStreamTrack } | null>(null);
  const flatSinceRef = useRef(0);
  const lastRebuildRef = useRef(0);
  const micAliveRef = useRef(false);
  const peakRef = useRef(0);
  const flatRebuildsRef = useRef(0);
  const needSpeechRef = useRef(0);
  // «Реакция» партнёра: громкость и темп последней реплики актёра.
  const loudSumRef = useRef(0);
  const loudNRef = useRef(0);
  const sessionLoudRef = useRef({ sum: 0, n: 0 });
  const reactRef = useRef<{ rate: number; vol: number } | null>(null);
  const [reactInfo, setReactInfo] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mixRef = useRef<{ dest: MediaStreamAudioDestinationNode; micGain: GainNode; micSrc: MediaStreamAudioSourceNode } | null>(null);
  const buffersRef = useRef<Record<number, AudioBuffer>>({});
  const playingRef = useRef<Stopper>(null);
  const cursorRef = useRef(0);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const clipRecRef = useRef<MediaRecorder | null>(null);
  const settingsRef = useRef(settings);
  const recStartRef = useRef(0);
  settingsRef.current = settings;
  const turnRef = useRef<Turn>('idle');
  const recognizerRef = useRef<Recognizer | null>(null);
  const turnStartRef = useRef(0);
  const lastVoiceRef = useRef(0);
  const lastTextRef = useRef(0);
  const speechMsRef = useRef(0);
  const lineDoneRef = useRef(false);
  const advancingRef = useRef(false);
  const noiseFloorRef = useRef(0.02);
  const thresholdRef = useRef(0.05);
  const voiceSeenRef = useRef(false);
  const [diag, setDiag] = useState('');
  const setTurn = (t: Turn) => { turnRef.current = t; setTurnState(t); };

  const setCursor = (i: number) => { cursorRef.current = i; setCursorState(i); };
  const upd = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  useEffect(() => { try { localStorage.setItem('chudosufler.settings', JSON.stringify(settings)); } catch { /* ok */ } }, [settings]);

  // --- Диагностика среды при загрузке
  useEffect(() => {
    log(`UA: ${navigator.userAgent}`);
    log(`isSecureContext=${window.isSecureContext}, MediaRecorder=${typeof MediaRecorder !== 'undefined'}, AudioContext=${'AudioContext' in window}, speechSynthesis=${'speechSynthesis' in window}`);
    log(`Видео-форматы MediaRecorder: ${VIDEO_MIME_CANDIDATES.map((m) => `${m}=${isTypeSupported(m) ? 'да' : 'нет'}`).join('; ')}`);
    log(`Аудио-форматы MediaRecorder: ${AUDIO_MIME_CANDIDATES.map((m) => `${m}=${isTypeSupported(m) ? 'да' : 'нет'}`).join('; ')}`);
    const as = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    log(`navigator.audioSession: ${as ? as.type : 'нет'}`);
    if ('speechSynthesis' in window) {
      const load = () => {
        const v = speechSynthesis.getVoices();
        setVoices(v.filter((x) => x.lang.toLowerCase().startsWith('ru')));
        log(`Голоса TTS: всего ${v.length}, русских ${v.filter((x) => x.lang.toLowerCase().startsWith('ru')).length}`);
      };
      load();
      speechSynthesis.addEventListener('voiceschanged', load);
    }
    loadClips(PARTNER_INDEXES).then((c) => {
      setClipBlobs(c);
      if (Object.keys(c).length) log(`Из памяти браузера загружено записей реплик: ${Object.keys(c).length}`);
    });
  }, []);

  // --- Таймер записи
  useEffect(() => {
    if (phase !== 'recording') return;
    const id = setInterval(() => setElapsed((performance.now() - recStartRef.current) / 1000), 250);
    return () => clearInterval(id);
  }, [phase]);

  // --- Индикатор уровня микрофона
  useEffect(() => {
    let raf = 0;
    const data = new Uint8Array(512);
    let prevT = performance.now();
    const tick = () => {
      const a = analyserRef.current;
      const now = performance.now();
      if (a) {
        a.getByteTimeDomainData(data);
        let peak = 0;
        let flat = true;
        for (const v of data) { const d = Math.abs(v - 128); if (d > peak) peak = d; if (v !== 128) flat = false; }
        const lvl = peak / 128;
        peakRef.current = lvl;
        // Абсолютно ровный сигнал = микрофон для анализа «отвалился» (живой микрофон всегда шумит).
        if (flat) {
          if (!flatSinceRef.current) flatSinceRef.current = now;
          micAliveRef.current = false;
          if (now - flatSinceRef.current > 800 && now - lastRebuildRef.current > 2000) rebuildRef.current('цифровая тишина');
        } else { flatSinceRef.current = 0; micAliveRef.current = true; }
        setMicLevel(lvl);
        // Фоновый шум: быстро опускаемся к тишине, медленно поднимаемся. Пока говорит партнёр — не учитываем.
        // Пока актёр говорит (уровень выше порога), шум не пересчитываем — иначе порог «уползает» вверх за голосом.
        if (turnRef.current !== 'partner' && lvl < thresholdRef.current) {
          const f = noiseFloorRef.current;
          noiseFloorRef.current = lvl < f ? f * 0.9 + lvl * 0.1 : f * 0.9995 + lvl * 0.0005;
        }
        const thr = Math.min(0.15, Math.max(0.015, noiseFloorRef.current * SENS[settingsRef.current.sensitivity]));
        thresholdRef.current = thr;
        // Детектор голоса: только во время хода актёра (голос партнёра из динамика не в счёт).
        if (turnRef.current === 'actor' && now - turnStartRef.current > 300) {
          if (lvl > thr) {
            if (!voiceSeenRef.current) { voiceSeenRef.current = true; log(`Голос актёра замечен: уровень ${lvl.toFixed(3)}, порог ${thr.toFixed(3)}`); }
            lastVoiceRef.current = now;
            loudSumRef.current += lvl;
            loudNRef.current++;
          }
          // «Хвост» 200 мс: паузы между слогами считаем речью.
          if (lastVoiceRef.current && now - lastVoiceRef.current < 200) speechMsRef.current += now - prevT;
        }
      }
      prevT = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // --- «Слух»: анализатор уровня микрофона, который умеет переподключаться
  const rebuildRef = useRef<(why: string) => void>(() => {});
  const rebuildAnalyser = (why: string) => {
    const s = streamRef.current;
    const t = s?.getAudioTracks()[0];
    if (!s || !t || t.readyState !== 'live') return;
    lastRebuildRef.current = performance.now();
    flatSinceRef.current = 0;
    try { micSrcRef.current?.node.disconnect(); micSrcRef.current?.track.stop(); } catch { /* ok */ }
    // Каждые второй и далее разы пересоздаём и сам контекст.
    let ctx = micCtxRef.current;
    if (why === 'цифровая тишина') flatRebuildsRef.current++; else flatRebuildsRef.current = 0;
    // Первая попытка — новый источник в том же контексте, со второй — пересоздаём и сам контекст.
    if (!ctx || ctx.state === 'closed' || flatRebuildsRef.current >= 2) {
      try { ctx?.close(); } catch { /* ok */ }
      ctx = new AudioContext();
      micCtxRef.current = ctx;
    }
    ctx.resume().catch(() => {});
    const clone = t.clone();
    const node = ctx.createMediaStreamSource(new MediaStream([clone]));
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    node.connect(an);
    micSrcRef.current = { node, track: clone };
    analyserRef.current = an;
    log(`Слух переподключён (${why}): AudioContext ${ctx.state}`);
  };
  rebuildRef.current = rebuildAnalyser;

  const ensureCtx = useCallback((): AudioContext => {
    if (!ctxRef.current || ctxRef.current.state === 'closed') {
      const ctx = new AudioContext();
      ctx.onstatechange = () => {
        log(`AudioContext: ${ctx.state}`, ctx.state === 'running' ? 'info' : 'warn');
        // iPhone «усыпляет» звук страницы на время синтеза речи — сразу будим обратно.
        if (ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
      };
      log(`AudioContext создан: ${ctx.sampleRate} Гц, ${ctx.state}`);
      ctxRef.current = ctx;
    }
    return ctxRef.current;
  }, []);

  const resumeCtx = useCallback(async () => {
    const ctx = ensureCtx();
    if (ctx.state !== 'running') {
      try { await ctx.resume(); } catch (e) { log(`ctx.resume: ${errText(e)}`, 'warn'); }
    }
    return ctx;
  }, [ensureCtx]);

  const decodeClip = useCallback(async (i: number, blob: Blob) => {
    const ctx = ensureCtx();
    try {
      const raw = await ctx.decodeAudioData(await blob.arrayBuffer());
      const { buf, gain, trimmed } = prepareClip(ctx, raw);
      log(`Реплика #${i}: громкость ×${gain.toFixed(1)}, обрезано тишины ${trimmed.toFixed(2)} с`);
      buffersRef.current[i] = buf;
      setClipDur((d) => ({ ...d, [i]: buf.duration }));
      log(`Реплика #${i} декодирована: ${buf.duration.toFixed(2)} с, ${blob.type || 'тип не указан'}`);
    } catch (e) {
      log(`Не удалось декодировать реплику #${i} (${blob.type}): ${errText(e)}`, 'error');
    }
  }, [ensureCtx]);

  // --- Камера
  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
  };

  const enableCamera = async () => {
    setError('');
    setPhase('opening');
    stopStream();
    try {
      const s = await openCamera({
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
      });
      streamRef.current = s;
      for (const t of s.getTracks()) {
        t.onended = () => {
          log(`Трек ${t.kind} завершён системой`, 'error');
          if (t.kind === 'audio') setMicState('отключён');
          if (recorderRef.current?.state === 'recording') setWarning(`Система остановила ${t.kind === 'audio' ? 'микрофон' : 'камеру'} во время записи.`);
        };
        t.onmute = () => { log(`Трек ${t.kind}: mute`, 'warn'); if (t.kind === 'audio') setMicState('заглушён системой'); };
        t.onunmute = () => { log(`Трек ${t.kind}: unmute`); if (t.kind === 'audio') setMicState('работает'); };
      }
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        await videoRef.current.play().catch((e) => log(`video.play: ${errText(e)}`, 'warn'));
      }
      // AudioContext создаём ПОСЛЕ getUserMedia — на iOS так меньше проблем с частотой и маршрутом звука.
      const ctx = await resumeCtx();
      void ctx;
      rebuildAnalyser('камера включена');
      setMicState(s.getAudioTracks()[0]?.muted ? 'заглушён системой' : 'работает');
      for (const [k, b] of Object.entries(clipBlobs)) if (!buffersRef.current[+k]) await decodeClip(+k, b);
      setPhase(result ? 'done' : 'ready');
    } catch (e) {
      log(`getUserMedia: ${errText(e)}`, 'error');
      setError(explainGumError(e));
      setMicState('нет доступа');
      setPhase('idle');
    }
  };

  // --- Воспроизведение реплики партнёра
  const playLine = async (i: number) => {
    const s = settingsRef.current;
    const ctx = await resumeCtx();
    playingRef.current?.stop();
    const mix = mixRef.current;
    const outputs: AudioNode[] = [ctx.destination];
    if (s.audioMode === 'mix' && mix) outputs.push(mix.dest);

    const buf = buffersRef.current[i];
    const useClip = s.partnerSource === 'clips' && buf;
    if (s.partnerSource === 'clips' && !buf) log(`Для реплики #${i} нет аудиозаписи — использую TTS`, 'warn');
    if (!useClip && s.audioMode === 'mix' && recorderRef.current?.state === 'recording') {
      log('TTS нельзя подмешать в дорожку напрямую: в запись голос попадёт только через микрофон', 'warn');
    }

    setLastPartner(i);
    setPartnerSpeaking(true);
    if (mix && s.duckMic) mix.micGain.gain.setValueAtTime(0, ctx.currentTime);
    const tStart = performance.now();
    log(`▶ Партнёр, реплика #${i}: «${SCENE[i].text}» (${useClip ? 'аудиофайл' : 'TTS'}, ${s.audioMode === 'mix' ? 'микс' : 'динамик'})`);
    setTurn('partner');
    const react = s.mirror && recorderRef.current?.state === 'recording' ? reactRef.current : null;
    let h: { done: Promise<void>; stop: () => void };
    if (useClip) {
      const g = ctx.createGain();
      g.gain.value = s.partnerVolume * 1.5; // записи уже выровнены; 100% на ползунке = ×1,5
      outputs.forEach((o) => g.connect(o));
      if (react) g.gain.value *= react.vol;
      // Для записанного голоса темп меняем осторожно: вместе с ним меняется высота голоса.
      h = playBuffer(ctx, buf, [g], react ? Math.max(0.92, Math.min(1.1, react.rate)) : 1);
      h.done.then(() => g.disconnect());
    } else {
      h = speak(SCENE[i].text, s.voiceName || null, s.partnerVolume * (react?.vol ?? 1), react?.rate ?? 1);
    }
    playingRef.current = h;
    await h.done;
    if (playingRef.current === h) {
      playingRef.current = null;
      setPartnerSpeaking(false);
      if (mix && s.duckMic) mix.micGain.gain.setValueAtTime(1, ctx.currentTime);
      log(`■ Партнёр закончил (${((performance.now() - tStart) / 1000).toFixed(2)} с)`);
      beginActorTurn();
    }
  };

  // --- Ход актёра и автоматический переход
  const beginActorTurn = () => {
    const c = cursorRef.current;
    if (recorderRef.current?.state !== 'recording' || c >= SCENE.length || SCENE[c].who !== 'actor') { setTurn('idle'); return; }
    setTurn('actor');
    turnStartRef.current = performance.now();
    lastVoiceRef.current = 0;
    lastTextRef.current = 0;
    speechMsRef.current = 0;
    loudSumRef.current = 0;
    loudNRef.current = 0;
    lineDoneRef.current = false;
    advancingRef.current = false;
    voiceSeenRef.current = false;
    recognizerRef.current?.newTurn();
    const ctx = ctxRef.current;
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
    // После голоса партнёра на iPhone «слух» мог отвалиться — переподключаем заранее.
    rebuildAnalyser('начало хода актёра');
    const at = streamRef.current?.getAudioTracks()[0];
    log(`Ход актёра: AudioContext=${ctx?.state}, микрофон ${at ? `${at.readyState}${at.muted ? ', ЗАГЛУШЁН' : ''}` : 'нет'}, распознавание=${recognizerRef.current ? (recognizerRef.current.failed ? 'сломалось' : 'есть') : 'выкл'}, шум ${noiseFloorRef.current.toFixed(3)}`);
    setHeard('');
    setMatched(words(SCENE[c].text).map(() => false));
  };

  const onRecognized = (text: string) => {
    if (turnRef.current !== 'actor' || performance.now() - turnStartRef.current < 300) return;
    const c = cursorRef.current;
    if (c >= SCENE.length) return;
    lastTextRef.current = performance.now();
    const p = matchLine(SCENE[c].text, text);
    setHeard(text);
    setMatched(p.matched);
    if (p.done && !lineDoneRef.current) {
      lineDoneRef.current = true;
      log(`Реплика актёра распознана: «${text}» (совпадение ${(p.coverage * 100).toFixed(0)}%)`);
    }
  };

  const autoAdvance = (why: string) => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    const waited = (performance.now() - Math.max(lastVoiceRef.current, lastTextRef.current)) / 1000;
    log(`Авто-переход: ${why}, пауза после голоса ${waited.toFixed(2)} с`);
    playNextPartner();
  };

  useEffect(() => {
    if (phase !== 'recording' || settings.advanceMode === 'manual') return;
    const id = setInterval(() => {
      const ctx = ctxRef.current;
      if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
      const mctx = micCtxRef.current;
      if (mctx && mctx.state !== 'running' && mctx.state !== 'closed') mctx.resume().catch(() => {});
      const now0 = performance.now();
      const ls = Math.max(lastVoiceRef.current, lastTextRef.current);
      setDiag(`ход: ${turnRef.current} · звук: ${ctx?.state ?? '—'} · слух: ${mctx?.state ?? '—'}/${micAliveRef.current ? 'живой' : 'ТИШИНА'} пик ${peakRef.current.toFixed(3)} · голос ${(speechMsRef.current / 1000).toFixed(1)} из ${(needSpeechRef.current / 1000).toFixed(1)} с · тишина ${ls ? ((now0 - ls) / 1000).toFixed(1) : '—'} с · порог ${thresholdRef.current.toFixed(3)}${recognizerRef.current ? ` · распозн.: ${recognizerRef.current.failed ? 'ошибка' : recognizerRef.current.status}` : ''}`);
      if (turnRef.current !== 'actor' || advancingRef.current) return;
      const s = settingsRef.current;
      const now = performance.now();
      const delayMs = s.replyDelay * 1000;
      const lastSound = Math.max(lastVoiceRef.current, lastTextRef.current);
      const silentFor = lastSound ? now - lastSound : 0;
      const c = cursorRef.current;
      if (c >= SCENE.length) return;
      // Ожидаемая длительность реплики ~0,35 с на слово; актёр должен проговорить хотя бы половину.
      // Ожидаемое время звучания реплики: ~0,33 с на слово. Пока не проговорено ≥60% — это пауза ВНУТРИ реплики, ждём.
      const estMs = words(SCENE[c].text).length * 330;
      const minSpeech = Math.max(400, estMs * 0.6);
      needSpeechRef.current = minSpeech;
      if (s.advanceMode === 'timer') {
        // Не зависит от микрофона: ждём примерную длительность реплики (~0,45 с на слово) + паузу.
        const wait = words(SCENE[c].text).length * 450 + 600 + delayMs;
        if (now - turnStartRef.current >= wait) autoAdvance('по времени');
        return;
      }
      const useVad = s.advanceMode === 'vad' || recognizerRef.current?.failed;
      if (!useVad) {
        if (lineDoneRef.current && silentFor >= delayMs) autoAdvance('реплика распознана');
        // Страховка: распознавание ничего не прислало за весь ход, но голос был и долго тихо.
        else if (!lastTextRef.current && speechMsRef.current >= minSpeech && silentFor >= delayMs + 1000) autoAdvance('распознавание молчит, сработала пауза');
      } else if (speechMsRef.current >= minSpeech && silentFor >= delayMs) {
        autoAdvance('пауза в голосе');
      } else if (speechMsRef.current >= estMs * 0.35 && silentFor >= delayMs + 3000) {
        // Страховка: голос был, но тихий — после долгой тишины всё равно отвечаем.
        autoAdvance('долгая тишина после голоса');
      }
    }, 100);
    return () => clearInterval(id);
  }, [phase, settings.advanceMode]);

  // Снимок того, КАК актёр сказал реплику: темп (слов в секунду звучания) и громкость относительно его же среднего.
  const snapshotReaction = () => {
    const c = cursorRef.current;
    if (turnRef.current !== 'actor' || c >= SCENE.length || SCENE[c].who !== 'actor') return;
    const secs = speechMsRef.current / 1000;
    if (secs < 0.3 || loudNRef.current < 5) { reactRef.current = null; return; }
    const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
    const wps = words(SCENE[c].text).length / secs;
    // Отражаем темп не полностью (на 70%), чтобы Петя не «передразнивал».
    const rate = clamp(1 + (wps / 2.6 - 1) * 0.7, 0.8, 1.25);
    const loud = loudSumRef.current / loudNRef.current;
    const sl = sessionLoudRef.current;
    const vol = sl.n ? clamp(1 + (loud / (sl.sum / sl.n) - 1) * 0.8, 0.65, 1.35) : 1;
    sl.sum += loud;
    sl.n++;
    reactRef.current = { rate, vol };
    const info = `темп ×${rate.toFixed(2)} (${wps.toFixed(1)} сл/с), громкость ×${vol.toFixed(2)}`;
    setReactInfo(info);
    log(`Реакция партнёра: ${info}`);
  };

  const playNextPartner = () => {
    snapshotReaction();
    const i = PARTNER_INDEXES.find((p) => p >= cursorRef.current);
    if (i === undefined) { log('Реплики партнёра закончились'); return; }
    setCursor(i + 1);
    void playLine(i);
  };

  const repeatPartner = () => { if (lastPartner !== null) void playLine(lastPartner); };

  // --- Запись
  const startRecording = async () => {
    const s = streamRef.current;
    if (!s) return;
    setWarning('');
    if (typeof MediaRecorder === 'undefined') { setError('MediaRecorder не поддерживается этим браузером.'); return; }
    // iOS разрешает синтез речи только из жеста пользователя: «разблокируем» его тихой фразой прямо в обработчике нажатия,
    // иначе первая реплика, запущенная по таймеру, может не прозвучать.
    if (settings.partnerSource === 'tts' && 'speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
    if (settings.advanceMode === 'speech') {
      // Запускаем прямо из нажатия: на iPhone распознавание без жеста может не стартовать.
      const r = new Recognizer();
      r.onText = onRecognized;
      r.onFatal = (code) => {
        setSrFailed(true);
        log(`Распознавание недоступно (${code}) — перехожу на авто-переход «по паузе»`, 'warn');
      };
      setSrFailed(false);
      recognizerRef.current = r;
      r.start();
    } else recognizerRef.current = null;
    micCtxRef.current?.resume().catch(() => {});
    const ctx = await resumeCtx();
    let recStream: MediaStream;
    if (settings.audioMode === 'mix') {
      const dest = ctx.createMediaStreamDestination();
      const micSrc = ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks()));
      const micGain = ctx.createGain();
      micSrc.connect(micGain).connect(dest);
      mixRef.current = { dest, micGain, micSrc };
      recStream = new MediaStream([...s.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      log('Режим звука: микс (микрофон + голос партнёра через Web Audio)');
    } else {
      mixRef.current = null;
      recStream = new MediaStream([...s.getVideoTracks(), ...s.getAudioTracks()]);
      log('Режим звука: динамик → микрофон');
    }
    const mime = settings.mimeType || pickVideoMime();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(recStream, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 } : undefined);
    } catch (e) {
      log(`MediaRecorder(${mime}): ${errText(e)} — пробую без параметров`, 'warn');
      rec = new MediaRecorder(recStream);
    }
    chunksRef.current = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
    rec.onerror = (e) => { log(`MediaRecorder ошибка: ${errText((e as unknown as { error?: unknown }).error ?? e)}`, 'error'); setWarning('Запись прервалась с ошибкой — см. журнал.'); };
    rec.onpause = () => log('MediaRecorder: pause', 'warn');
    rec.onresume = () => log('MediaRecorder: resume');
    rec.onstop = () => finalize(rec);
    rec.start(1000);
    recorderRef.current = rec;
    recStartRef.current = performance.now();
    log(`Запись началась: ${rec.mimeType || mime || 'формат по умолчанию'}`);
    try {
      const wl = (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock;
      if (wl) wakeLockRef.current = await wl.request('screen');
    } catch (e) { log(`wakeLock: ${errText(e)}`, 'warn'); }
    setElapsed(0);
    setCursor(0);
    setLastPartner(null);
    reactRef.current = null;
    sessionLoudRef.current = { sum: 0, n: 0 };
    setReactInfo('');
    setPhase('recording');
    setTurn('idle');
    if (SCENE[0].who === 'actor') beginActorTurn();
    else if (settings.autoFirstLine || settings.advanceMode !== 'manual') setTimeout(() => { if (recorderRef.current?.state === 'recording') playNextPartner(); }, 1000);
  };

  const stopRecording = () => {
    recognizerRef.current?.stop();
    recognizerRef.current = null;
    setTurn('idle');
    playingRef.current?.stop();
    playingRef.current = null;
    setPartnerSpeaking(false);
    const r = recorderRef.current;
    if (r && r.state !== 'inactive') r.stop();
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
  };

  const finalize = (rec: MediaRecorder) => {
    const mime = rec.mimeType || settings.mimeType || pickVideoMime() || 'video/mp4';
    const blob = new Blob(chunksRef.current, { type: mime.split(';')[0] });
    const dur = (performance.now() - recStartRef.current) / 1000;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const name = `chudosufler-${stamp}.${extForMime(mime)}`;
    log(`Запись остановлена: ${chunksRef.current.length} фрагментов, ${(blob.size / 1024 / 1024).toFixed(2)} МБ, ~${dur.toFixed(1)} с, ${mime}`);
    if (mixRef.current) {
      try { mixRef.current.micSrc.disconnect(); mixRef.current.micGain.disconnect(); } catch { /* ok */ }
      mixRef.current = null;
    }
    if (!blob.size) { setWarning('Видео получилось пустым (0 байт). См. журнал.'); log('Пустой результат записи', 'error'); }
    setResult((old) => { if (old) URL.revokeObjectURL(old.url); return { url: URL.createObjectURL(blob), blob, mime, name, duration: dur }; });
    setPhase('done');
  };

  const shareResult = async () => {
    if (!result) return;
    const file = new File([result.blob], result.name, { type: result.blob.type });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Самопроба' });
        log('Файл передан в «Поделиться»');
      } else {
        log('navigator.share с файлами не поддерживается — используйте «Скачать»', 'warn');
        setWarning('Этот браузер не умеет «Поделиться» файлом. Нажмите «Скачать».');
      }
    } catch (e) { log(`share: ${errText(e)}`, 'warn'); }
  };

  const canShareFiles = (() => {
    try { return !!navigator.canShare?.({ files: [new File([new Blob()], 'x.mp4', { type: 'video/mp4' })] }); } catch { return false; }
  })();

  const newTake = () => { setPhase(streamRef.current ? 'ready' : 'idle'); setCursor(0); setLastPartner(null); };

  // --- Запись и загрузка реплик партнёра
  const recordClip = async (i: number) => {
    const s = streamRef.current;
    if (!s) { setError('Сначала включите камеру и микрофон.'); return; }
    if (clipRecRef.current?.state === 'recording') { clipRecRef.current.stop(); return; }
    const mime = pickAudioMime();
    const r = new MediaRecorder(new MediaStream(s.getAudioTracks()), mime ? { mimeType: mime } : undefined);
    const parts: Blob[] = [];
    r.ondataavailable = (e) => e.data.size && parts.push(e.data);
    r.onstop = async () => {
      setRecordingClip(null);
      clipRecRef.current = null;
      const b = new Blob(parts, { type: (r.mimeType || mime || 'audio/mp4').split(';')[0] });
      await storeClip(i, b);
    };
    r.start();
    clipRecRef.current = r;
    setRecordingClip(i);
    log(`Запись реплики партнёра #${i} (${r.mimeType || mime})`);
  };

  const storeClip = async (i: number, b: Blob) => {
    setClipBlobs((c) => ({ ...c, [i]: b }));
    try { await saveClip(i, b); } catch (e) { log(`IndexedDB: ${errText(e)}`, 'warn'); }
    await decodeClip(i, b);
    upd('partnerSource', 'clips');
  };

  const uploadClip = async (i: number, f: File | undefined) => {
    if (!f) return;
    log(`Загружен файл для реплики #${i}: ${f.name}, ${f.type}, ${(f.size / 1024).toFixed(0)} КБ`);
    await storeClip(i, f);
  };

  const uploadMany = async (list: FileList | null) => {
    if (!list?.length) return;
    const fs = Array.from(list);
    const free = PARTNER_INDEXES.slice();
    // Сначала раскладываем по номеру из имени файла, остальные — по порядку.
    const plan: [number, File][] = [];
    for (const f of fs) {
      const n = lineIndexFromName(f.name);
      if (n !== null && free.includes(n)) { plan.push([n, f]); free.splice(free.indexOf(n), 1); }
    }
    for (const f of fs) if (!plan.some(([, x]) => x === f) && free.length) plan.push([free.shift()!, f]);
    for (const [i, f] of plan) await uploadClip(i, f);
    setWarning('');
    log(`Загружено файлов от партнёра: ${plan.length}`);
  };

  const invitePartner = async () => {
    const url = `${location.origin}${location.pathname}#partner`;
    const text = 'Привет! Озвучь, пожалуйста, реплики Пети для моей самопробы — открой ссылку на телефоне, запиши 3 фразы и нажми «Отправить актёру»:';
    try {
      if (navigator.share) { await navigator.share({ title: 'ЧудоСуфлёр — реплики партнёра', text, url }); return; }
    } catch (e) { if ((e as Error).name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(`${text} ${url}`); setWarning('Ссылка для партнёра скопирована — вставьте её в мессенджер.'); }
    catch { setWarning(`Отправьте партнёру ссылку: ${url}`); }
  };

  const removeClip = async (i: number) => {
    delete buffersRef.current[i];
    setClipBlobs((c) => { const n = { ...c }; delete n[i]; return n; });
    setClipDur((d) => { const n = { ...d }; delete n[i]; return n; });
    try { await deleteClip(i); } catch { /* ok */ }
  };

  const logEntries = useLog();
  const recording = phase === 'recording';
  const camOn = phase === 'ready' || phase === 'recording' || (phase === 'done' && !!streamRef.current);
  const nextPartner = PARTNER_INDEXES.find((p) => p >= cursor);
  const actorLine = cursor < SCENE.length && SCENE[cursor].who === 'actor' ? SCENE[cursor] : null;
  const missingClips = PARTNER_INDEXES.filter((i) => !clipBlobs[i]).length;

  return (
    <div className="app">
      <div className="stage" onClick={() => {
        // Касание экрана — «жест» для iPhone: будим оба звуковых контекста.
        ctxRef.current?.resume().catch(() => {});
        micCtxRef.current?.resume().catch(() => {});
      }}>
        <video ref={videoRef} className={`preview ${phase === 'done' ? 'hidden' : ''}`} playsInline muted autoPlay />
        {phase === 'done' && result && (
          <video key={result.url} className="preview result" src={result.url} controls playsInline
            onLoadedMetadata={(e) => log(`Плеер результата: длительность ${e.currentTarget.duration} с, ${e.currentTarget.videoWidth}×${e.currentTarget.videoHeight}`)}
            onError={() => log('Плеер не смог открыть итоговый файл', 'error')} />
        )}
        {!camOn && phase !== 'done' && <div className="placeholder">Камера выключена</div>}
        <div className="badges">
          {recording && <span className="badge rec">● REC {fmt(elapsed)}</span>}
          {partnerSpeaking && <span className="badge partner">🔊 Говорит партнёр</span>}
          {recording && turn === 'actor' && <span className="badge listen">👂 Слушаю{settings.advanceMode === 'manual' ? '' : settings.advanceMode === 'vad' || srFailed ? ' (по паузе)' : ''}</span>}
          <span className="badge mic">
            🎙 {micState}
            <span className="meter">
              <span style={{ width: `${Math.min(100, micLevel * 300)}%`, background: micLevel > thresholdRef.current ? '#3fb950' : '#6e7681' }} />
            </span>
          </span>
        </div>
        {recording && (
          <div className="prompter">
            {(partnerSpeaking || turn !== 'actor') && lastPartner !== null && (
              <div className="p-partner">ПЕТЯ: {SCENE[lastPartner].text}</div>
            )}
            {actorLine ? (
              <div className={`p-actor ${turn === 'actor' ? 'active' : ''}`}>
                {actorLine.text.split(/\s+/).map((w, k) => (
                  <span key={k} className={matched[k] && turn === 'actor' ? 'said' : ''}>{w} </span>
                ))}
              </div>
            ) : cursor >= SCENE.length ? (
              <div className="p-actor">Сцена окончена — «Стоп»</div>
            ) : null}
          </div>
        )}
      </div>

      {error && <div className="alert error">{error}</div>}
      {warning && <div className="alert warn">{warning}</div>}

      {phase !== 'done' && (
        <div className="lines">
          <div className="line partner">
            <div className="who">ПЕТЯ (суфлёр){lastPartner !== null ? '' : ' — следующая'}</div>
            <div className="text">{lastPartner !== null ? SCENE[lastPartner].text : nextPartner !== undefined ? SCENE[nextPartner].text : '—'}</div>
          </div>
          {recording && settings.advanceMode !== 'manual' && <div className="diag">{diag}{settings.mirror && reactInfo ? ` · Петя: ${reactInfo}` : ''}</div>}
          {recording && turn === 'actor' && heard && settings.advanceMode === 'speech' && (
            <div className="heard">Слышу: {heard}</div>
          )}
          <div className="line actor">
            <div className="who">МАША (вы)</div>
            <div className="text">{actorLine ? actorLine.text : cursor >= SCENE.length ? 'Сцена окончена — нажмите «Стоп»' : '…ждём реплику партнёра'}</div>
          </div>
        </div>
      )}

      <div className="controls">
        {(phase === 'idle' || phase === 'opening') && (
          <button className="big primary" disabled={phase === 'opening'} onClick={enableCamera}>
            {phase === 'opening' ? 'Запрашиваю доступ…' : 'Включить камеру и микрофон'}
          </button>
        )}
        {phase === 'ready' && <button className="big rec" onClick={startRecording}>● Начать запись</button>}
        {recording && (
          <>
            <button className="big primary" onClick={playNextPartner} disabled={nextPartner === undefined}>{settings.advanceMode === 'manual' ? '▶ Следующая реплика' : '▶ Следующая (вручную)'}</button>
            <label className="field">Громкость партнёра: {Math.round(settings.partnerVolume * 100)}%
              <input type="range" min={0.1} max={1} step={0.05} value={settings.partnerVolume} onChange={(e) => upd('partnerVolume', Number(e.target.value))} />
            </label>
            <div className="row">
              <button onClick={repeatPartner} disabled={lastPartner === null}>↻ Повторить</button>
              <button className="stop" onClick={stopRecording}>■ Стоп</button>
            </div>
          </>
        )}
        {phase === 'done' && result && (
          <>
            <div className="meta">{result.name} · {(result.blob.size / 1024 / 1024).toFixed(1)} МБ · {result.mime}</div>
            <div className="row">
              {canShareFiles ? (
                <>
                  <button className="big primary" onClick={shareResult}>📲 Сохранить в «Фото»</button>
                </>
              ) : (
                <a className="btn big primary" href={result.url} download={result.name}>⬇ Скачать видео</a>
              )}
            </div>
            {canShareFiles && <p className="hint">В открывшемся меню выберите «Сохранить видео» — ролик сразу окажется в «Фото». Там же можно отправить его в Telegram или WhatsApp.</p>}
            <div className="row">
              {canShareFiles && <a className="btn" href={result.url} download={result.name}>Скачать файлом</a>}
            </div>
            <button onClick={streamRef.current ? newTake : enableCamera}>Новый дубль</button>
          </>
        )}
      </div>

      <details className="panel" open={phase === 'idle'}>
        <summary>Настройки эксперимента</summary>
        <fieldset disabled={recording}>
          <label className="field">Переход к следующей реплике партнёра
            <select value={settings.advanceMode} onChange={(e) => upd('advanceMode', e.target.value as AdvanceMode)}>
              <option value="speech" disabled={!speechRecognitionSupported()}>Авто: по распознаванию речи{speechRecognitionSupported() ? '' : ' (нет в этом браузере)'}</option>
              <option value="vad">Авто: по паузе в голосе (без распознавания)</option>
              <option value="timer">Авто: по времени (без микрофона, запасной)</option>
              <option value="manual">Вручную, кнопкой</option>
            </select>
          </label>
          {settings.advanceMode !== 'manual' && (
            <label className="field">Пауза перед ответом партнёра
              <select value={settings.replyDelay} onChange={(e) => upd('replyDelay', Number(e.target.value))}>
                <option value={0.5}>0,5 с</option>
                <option value={1}>1 с</option>
                <option value={2}>2 с</option>
                <option value={3}>3 с</option>
              </select>
            </label>
          )}
          <label className="field">Громкость партнёра: {Math.round(settings.partnerVolume * 100)}%
            <input type="range" min={0.1} max={1} step={0.05} value={settings.partnerVolume} onChange={(e) => upd('partnerVolume', Number(e.target.value))} />
          </label>
          {settings.advanceMode !== 'manual' && (
            <label className="field">Чувствительность к голосу
              <select value={settings.sensitivity} onChange={(e) => upd('sensitivity', e.target.value as Settings['sensitivity'])}>
                <option value="high">Высокая (телефон далеко, тихий голос)</option>
                <option value="mid">Средняя</option>
                <option value="low">Низкая (шумно вокруг)</option>
              </select>
            </label>
          )}
          <label className="field">Как голос партнёра попадает в видео
            <select value={settings.audioMode} onChange={(e) => upd('audioMode', e.target.value as AudioMode)}>
              <option value="speaker">Вариант 1: динамик → микрофон</option>
              <option value="mix">Вариант 2: подмешивать в дорожку (Web Audio)</option>
            </select>
          </label>
          <label className="field">Источник голоса партнёра
            <select value={settings.partnerSource} onChange={(e) => upd('partnerSource', e.target.value as PartnerSource)}>
              <option value="tts">Синтез речи телефона (бесплатно)</option>
              <option value="clips">Аудиозаписи реплик {missingClips ? `(не хватает ${missingClips})` : '✓'}</option>
            </select>
          </label>
          {settings.audioMode === 'mix' && settings.partnerSource === 'tts' && (
            <p className="hint warn">Синтез речи браузера нельзя подмешать в дорожку — для варианта 2 запишите или загрузите аудио реплик ниже.</p>
          )}
          {settings.partnerSource === 'tts' && voices.length > 0 && (
            <label className="field">Голос
              <select value={settings.voiceName} onChange={(e) => upd('voiceName', e.target.value)}>
                <option value="">Авто (первый русский)</option>
                {voices.map((v) => <option key={v.name} value={v.name}>{v.name}{v.localService ? '' : ' (онлайн)'}</option>)}
              </select>
              <button type="button" onClick={() => speak(SCENE[0].text, settings.voiceName || null, settings.partnerVolume)}>▶ Прослушать голос</button>
            </label>
          )}
          {settings.partnerSource === 'tts' && voices.length === 0 && <p className="hint warn">Русские голоса синтеза не найдены (или ещё не загрузились).</p>}
          <Check label="Подавление эха (echoCancellation)" v={settings.echoCancellation} on={(v) => upd('echoCancellation', v)} />
          <Check label="Шумоподавление (noiseSuppression)" v={settings.noiseSuppression} on={(v) => upd('noiseSuppression', v)} />
          <Check label="Автоусиление (autoGainControl)" v={settings.autoGainControl} on={(v) => upd('autoGainControl', v)} />
          {settings.audioMode === 'mix' && <Check label="Глушить микрофон в записи, пока говорит партнёр" v={settings.duckMic} on={(v) => upd('duckMic', v)} />}
          <Check label="Петя подстраивается под мой темп и громкость" v={settings.mirror} on={(v) => upd('mirror', v)} />
          <Check label="Первая реплика партнёра сама через 1 с после старта" v={settings.autoFirstLine} on={(v) => upd('autoFirstLine', v)} />
          <label className="field">Формат видео
            <select value={settings.mimeType} onChange={(e) => upd('mimeType', e.target.value)}>
              <option value="">Авто ({pickVideoMime() || 'по умолчанию'})</option>
              {supportedVideoMimes().map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          {camOn && <button onClick={enableCamera}>Перезапустить камеру (применить настройки микрофона)</button>}
        </fieldset>
      </details>

      <details className="panel">
        <summary>Аудио реплик партнёра {missingClips ? `(${PARTNER_INDEXES.length - missingClips}/${PARTNER_INDEXES.length})` : '✓'}</summary>
        <p className="hint">Громкость записей выравнивается автоматически. Записи хранятся только в этом браузере.</p>
        <button className="primary" style={{ width: '100%', marginBottom: 8 }} disabled={recording} onClick={() => { stopStream(); location.hash = '#record'; }}>🎙 Записать реплики Пети самой</button>
        <div className="row">
          <button disabled={recording} onClick={invitePartner}>📨 Пригласить партнёра</button>
          <label className="btn">📥 Загрузить файлы от партнёра<input type="file" accept="audio/*,.m4a,.mp4,.webm,.ogg,.mp3,.wav" multiple hidden disabled={recording} onChange={(e) => { void uploadMany(e.target.files); e.target.value = ''; }} /></label>
        </div>
        <details className="hint">
          <summary>Как получить записи от партнёра</summary>
          <ol style={{ paddingLeft: 18, margin: '6px 0' }}>
            <li>Нажмите «📨 Пригласить партнёра» и отправьте ссылку в Telegram или WhatsApp.</li>
            <li>Партнёр открывает ссылку, записывает реплики и нажимает «📤 Отправить актёру» — файлы придут вам в чат.</li>
            <li>На iPhone: в чате откройте каждый файл → «Поделиться» → «Сохранить в Файлы».</li>
            <li>Здесь нажмите «📥 Загрузить файлы от партнёра» и выберите все файлы сразу — они сами встанут на свои реплики.</li>
          </ol>
        </details>
        {PARTNER_INDEXES.map((i) => (
          <div key={i} className="clip">
            <div className="text">«{SCENE[i].text}»</div>
            <div className="row">
              <button className={recordingClip === i ? 'stop' : ''} disabled={recording || !camOn || (recordingClip !== null && recordingClip !== i)} onClick={() => recordClip(i)}>
                {recordingClip === i ? '■ Стоп' : '● Записать'}
              </button>
              <label className="btn">Файл…<input type="file" accept="audio/*" hidden disabled={recording} onChange={(e) => uploadClip(i, e.target.files?.[0])} /></label>
              {clipBlobs[i] && <button disabled={recording} onClick={() => playLine(i)}>▶ {clipDur[i] ? `${clipDur[i].toFixed(1)} с` : ''}</button>}
              {clipBlobs[i] && <button disabled={recording} onClick={() => removeClip(i)}>✕</button>}
            </div>
          </div>
        ))}
        {!camOn && <p className="hint">Чтобы записывать, сначала включите камеру и микрофон.</p>}
      </details>

      <details className="panel">
        <summary>Журнал диагностики ({logEntries.length})</summary>
        <div className="row">
          <button onClick={() => navigator.clipboard?.writeText(logAsText()).then(() => log('Журнал скопирован'), (e) => log(`clipboard: ${errText(e)}`, 'warn'))}>Копировать</button>
          <button onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([logAsText()], { type: 'text/plain' }));
            a.download = 'chudosufler-log.txt';
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          }}>Скачать .txt</button>
        </div>
        <pre className="log">{logEntries.slice().reverse().map((e, k) => (
          <div key={k} className={e.level}>{e.t.toFixed(2)}s {e.msg}</div>
        ))}</pre>
      </details>
    </div>
  );
}

function Check({ label, v, on }: { label: string; v: boolean; on: (v: boolean) => void }) {
  return <label className="check"><input type="checkbox" checked={v} onChange={(e) => on(e.target.checked)} /> {label}</label>;
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
