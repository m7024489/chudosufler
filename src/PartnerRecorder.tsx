import { useEffect, useRef, useState } from 'react';
import { SCENE, PARTNER_INDEXES } from './scene';
import { pickAudioMime, extForMime, explainGumError } from './media';
import { log, errText } from './log';
import { saveClip, loadClips } from './clipStore';

// Запись реплик Пети построчно.
//  mode="partner" (…/#partner) — на телефоне партнёра; в конце файлы отправляются актёру через «Поделиться».
//  mode="self"    (…/#record)  — на телефоне актёра; записи сразу сохраняются в этом браузере.
export default function PartnerRecorder({ mode }: { mode: 'partner' | 'self' }) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState('');
  const [clips, setClips] = useState<Record<number, Blob>>({});
  const [recIdx, setRecIdx] = useState<number | null>(null);
  const [level, setLevel] = useState(0);
  const [secs, setSecs] = useState(0);
  const [status, setStatus] = useState('');
  const [autoStop, setAutoStop] = useState(true);
  const recRef = useRef<MediaRecorder | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const anRef = useRef<AnalyserNode | null>(null);
  const voiceRef = useRef({ started: 0, lastVoice: 0, heard: false, floor: 0.02 });
  const autoStopRef = useRef(autoStop);
  autoStopRef.current = autoStop;

  useEffect(() => {
    if (mode === 'self') loadClips(PARTNER_INDEXES).then(setClips);
  }, [mode]);

  const streamRef = useRef<MediaStream | null>(null);
  streamRef.current = stream;
  // Освобождаем микрофон только при уходе со страницы.
  useEffect(() => () => { streamRef.current?.getTracks().forEach((t) => t.stop()); ctxRef.current?.close().catch(() => {}); }, []);

  // Уровень микрофона + автостоп: после того как голос прозвучал, 1,3 с тишины — запись останавливается.
  useEffect(() => {
    let raf = 0;
    const data = new Uint8Array(1024);
    const tick = () => {
      const an = anRef.current;
      if (an) {
        an.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
        setLevel(peak);
        const r = recRef.current;
        const v = voiceRef.current;
        const now = performance.now();
        if (r?.state === 'recording') {
          setSecs((now - v.started) / 1000);
          const thr = Math.max(0.04, v.floor * 3);
          if (peak > thr && now - v.started > 250) { v.heard = true; v.lastVoice = now; }
          if (autoStopRef.current && v.heard && now - v.lastVoice > 1300) r.stop();
          if (now - v.started > 20000) r.stop();
        } else if (peak < v.floor * 1.5 || v.floor === 0) {
          v.floor = v.floor * 0.95 + peak * 0.05; // фон, пока не записываем
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const enableMic = async () => {
    setError('');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(s).connect(an);
      await ctx.resume().catch(() => {});
      ctxRef.current = ctx;
      anRef.current = an;
      setStream(s);
    } catch (e) {
      log(`Запись реплик, микрофон: ${errText(e)}`, 'error');
      setError(explainGumError(e));
    }
  };

  const toggleRecord = (i: number) => {
    if (recRef.current?.state === 'recording') { recRef.current.stop(); return; }
    if (!stream) return;
    audioRef.current?.pause();
    ctxRef.current?.resume().catch(() => {});
    const mime = pickAudioMime();
    const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const parts: Blob[] = [];
    r.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    r.onstop = async () => {
      const b = new Blob(parts, { type: (r.mimeType || mime || 'audio/mp4').split(';')[0] });
      recRef.current = null;
      setRecIdx(null);
      if (!voiceRef.current.heard) { setStatus('Голос не услышан — попробуйте ещё раз ближе к телефону.'); return; }
      setClips((c) => ({ ...c, [i]: b }));
      setStatus('');
      if (mode === 'self') { try { await saveClip(i, b); } catch (e) { log(`IndexedDB: ${errText(e)}`, 'warn'); } }
    };
    voiceRef.current = { ...voiceRef.current, started: performance.now(), lastVoice: 0, heard: false };
    r.start();
    recRef.current = r;
    setRecIdx(i);
    setSecs(0);
  };

  const play = (i: number) => {
    const b = clips[i];
    if (!b) return;
    audioRef.current?.pause();
    const a = new Audio(URL.createObjectURL(b));
    audioRef.current = a;
    a.play().catch((e) => log(`play: ${errText(e)}`, 'warn'));
  };

  const files = () => PARTNER_INDEXES.filter((i) => clips[i]).map((i) => {
    const b = clips[i];
    return new File([b], `chudosufler-line-${i}.${extForMime(b.type)}`, { type: b.type });
  });

  const send = async () => {
    const f = files();
    try {
      if (navigator.canShare?.({ files: f })) {
        await navigator.share({ files: f, title: 'Реплики партнёра для ЧудоСуфлёра' });
        setStatus('Отправлено ✓ Актёру останется нажать «📥 Загрузить файлы от партнёра».');
        return;
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      log(`share: ${errText(e)}`, 'warn');
    }
    for (const file of f) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      a.click();
      await new Promise((r) => setTimeout(r, 400));
    }
    setStatus('Файлы скачаны — отправьте их актёру в мессенджере.');
  };

  const backToScene = () => { location.hash = ''; };

  const done = PARTNER_INDEXES.filter((i) => clips[i]).length;
  const all = done === PARTNER_INDEXES.length;

  return (
    <div className="app">
      <h2 style={{ margin: '12px 0 4px' }}>{mode === 'self' ? 'Запись реплик Пети' : 'ЧудоСуфлёр: озвучка партнёра'}</h2>
      <p className="hint" style={{ fontSize: 15 }}>
        {mode === 'partner'
          ? 'Вы озвучиваете Петю для самопробы. Нажмите «Записать», скажите реплику — запись остановится сама, когда вы замолчите. Прослушайте, при необходимости перезапишите. В конце нажмите «Отправить актёру».'
          : 'Нажмите «Записать» и скажите реплику Пети — запись остановится сама, когда вы замолчите. Записи сразу сохраняются для сцены.'}
        {' '}Держите телефон сантиметрах в 20–30 от рта.
      </p>
      {error && <div className="alert error">{error}</div>}
      {!stream && <button className="big primary" onClick={enableMic}>🎙 Включить микрофон</button>}
      {stream && (
        <>
          <div className="row" style={{ alignItems: 'center' }}>
            <span className="meter big-meter"><span style={{ width: `${Math.min(100, level * 250)}%` }} /></span>
            <label className="check" style={{ flex: 'none' }}><input type="checkbox" checked={autoStop} onChange={(e) => setAutoStop(e.target.checked)} /> автостоп</label>
          </div>
          {PARTNER_INDEXES.map((i, n) => (
            <div key={i} className={`line partner ${recIdx === i ? 'recording' : ''}`} style={{ margin: '10px 0' }}>
              <div className="who">РЕПЛИКА {n + 1} из {PARTNER_INDEXES.length} — ПЕТЯ {clips[i] ? '✓' : ''}</div>
              {i > 0 && SCENE[i - 1].who === 'actor' && <div className="hint" style={{ margin: '4px 0' }}>перед этим Маша: «{SCENE[i - 1].text}»</div>}
              <div className="text" style={{ margin: '6px 0 10px', fontSize: 24 }}>«{SCENE[i].text}»</div>
              <div className="row">
                <button className={recIdx === i ? 'stop' : 'rec'} disabled={recIdx !== null && recIdx !== i} onClick={() => toggleRecord(i)}>
                  {recIdx === i ? `■ Стоп (${secs.toFixed(1)} с)` : clips[i] ? '● Перезаписать' : '● Записать'}
                </button>
                {clips[i] && <button disabled={recIdx !== null} onClick={() => play(i)}>▶ Прослушать</button>}
              </div>
            </div>
          ))}
          {status && <div className="alert warn">{status}</div>}
          {mode === 'partner' ? (
            <button className="big primary" disabled={done === 0 || recIdx !== null} onClick={send}>
              📤 Отправить актёру ({done} из {PARTNER_INDEXES.length})
            </button>
          ) : (
            <button className="big primary" disabled={recIdx !== null} onClick={backToScene}>
              {all ? '✓ Готово — к сцене' : `К сцене (записано ${done} из ${PARTNER_INDEXES.length})`}
            </button>
          )}
        </>
      )}
      {mode === 'self' && !stream && <button style={{ marginTop: 10, width: '100%' }} onClick={backToScene}>← Назад к сцене</button>}
    </div>
  );
}
