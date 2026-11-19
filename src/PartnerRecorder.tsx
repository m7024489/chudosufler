import { useEffect, useRef, useState } from 'react';
import { SCENE, PARTNER_INDEXES } from './scene';
import { pickAudioMime, extForMime, explainGumError } from './media';
import { log, errText } from './log';

// Страница для партнёра: открывается по ссылке …/#partner на его телефоне.
// Он записывает реплики Пети и одним нажатием отправляет файлы актёру (Telegram, WhatsApp, почта).
export default function PartnerRecorder() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState('');
  const [clips, setClips] = useState<Record<number, Blob>>({});
  const [recIdx, setRecIdx] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const recRef = useRef<MediaRecorder | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);

  const enableMic = async () => {
    setError('');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      setStream(s);
    } catch (e) {
      log(`Партнёр, микрофон: ${errText(e)}`, 'error');
      setError(explainGumError(e));
    }
  };

  const toggleRecord = (i: number) => {
    if (recRef.current?.state === 'recording') { recRef.current.stop(); return; }
    if (!stream) return;
    const mime = pickAudioMime();
    const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const parts: Blob[] = [];
    r.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    r.onstop = () => {
      const b = new Blob(parts, { type: (r.mimeType || mime || 'audio/mp4').split(';')[0] });
      setClips((c) => ({ ...c, [i]: b }));
      setRecIdx(null);
      recRef.current = null;
    };
    r.start();
    recRef.current = r;
    setRecIdx(i);
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
        setStatus('Отправлено ✓');
        return;
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      log(`share: ${errText(e)}`, 'warn');
    }
    // Запасной вариант (компьютер и браузеры без «Поделиться»): скачиваем файлы по одному.
    for (const file of f) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      a.click();
      await new Promise((r) => setTimeout(r, 400));
    }
    setStatus('Файлы скачаны — отправьте их актёру в мессенджере.');
  };

  const done = PARTNER_INDEXES.filter((i) => clips[i]).length;

  return (
    <div className="app">
      <h2>ЧудоСуфлёр: запись реплик партнёра</h2>
      <p className="hint" style={{ fontSize: 15 }}>
        Вы озвучиваете Петю. Нажмите «Записать», прочитайте реплику с интонацией и нажмите «Стоп». Держите телефон сантиметрах в 20 от рта. Когда все реплики готовы, нажмите «Отправить актёру».
      </p>
      {error && <div className="alert error">{error}</div>}
      {!stream && <button className="big primary" onClick={enableMic}>Включить микрофон</button>}
      {stream && (
        <>
          {PARTNER_INDEXES.map((i, n) => (
            <div key={i} className="line partner" style={{ margin: '10px 0' }}>
              <div className="who">РЕПЛИКА {n + 1} — ПЕТЯ</div>
              {i > 0 && SCENE[i - 1].who === 'actor' && <div className="hint">перед этим Маша: «{SCENE[i - 1].text}»</div>}
              <div className="text" style={{ margin: '6px 0 10px' }}>«{SCENE[i].text}»</div>
              <div className="row">
                <button className={recIdx === i ? 'stop' : 'rec'} disabled={recIdx !== null && recIdx !== i} onClick={() => toggleRecord(i)}>
                  {recIdx === i ? '■ Стоп' : clips[i] ? '● Перезаписать' : '● Записать'}
                </button>
                {clips[i] && <button disabled={recIdx !== null} onClick={() => play(i)}>▶ Прослушать</button>}
              </div>
            </div>
          ))}
          <button className="big primary" disabled={done === 0 || recIdx !== null} onClick={send}>
            📤 Отправить актёру ({done} из {PARTNER_INDEXES.length})
          </button>
          {status && <p className="hint">{status}</p>}
        </>
      )}
    </div>
  );
}
