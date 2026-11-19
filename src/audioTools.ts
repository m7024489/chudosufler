// Обработка записанных реплик партнёра: обрезка тишины по краям и выравнивание громкости.
export function prepareClip(ctx: BaseAudioContext, buf: AudioBuffer): { buf: AudioBuffer; gain: number; trimmed: number } {
  const ch = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
  if (peak < 1e-4) return { buf, gain: 1, trimmed: 0 };

  // Тишина по краям: всё тише 6% от пика; оставляем по 80 мс запаса.
  const thr = peak * 0.06;
  const margin = Math.floor(buf.sampleRate * 0.08);
  let start = 0;
  while (start < ch.length && Math.abs(ch[start]) < thr) start++;
  let end = ch.length - 1;
  while (end > start && Math.abs(ch[end]) < thr) end--;
  start = Math.max(0, start - margin);
  end = Math.min(ch.length - 1, end + margin);
  const len = Math.max(1, end - start + 1);

  // Громкость: целимся в средний уровень речи ≈ −16 dBFS, но не даём пику выйти за 0,95.
  let sum = 0;
  for (let i = start; i <= end; i++) sum += ch[i] * ch[i];
  const rms = Math.sqrt(sum / len);
  const gain = Math.min(0.95 / peak, 0.16 / Math.max(rms, 1e-4), 12);

  const out = ctx.createBuffer(1, len, buf.sampleRate);
  const o = out.getChannelData(0);
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  for (let i = 0; i < len; i++) {
    let v = 0;
    for (const c of chans) v += c[start + i];
    v = (v / chans.length) * gain;
    o[i] = v > 0.99 ? 0.99 : v < -0.99 ? -0.99 : v;
  }
  return { buf: out, gain, trimmed: (ch.length - len) / buf.sampleRate };
}

/** Номер реплики из имени файла вида chudosufler-line-2.m4a */
export function lineIndexFromName(name: string): number | null {
  const m = name.match(/line-(\d+)/i);
  return m ? Number(m[1]) : null;
}
