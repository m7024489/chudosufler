import { log } from './log';

// ---------- Сопоставление речи с репликой ----------

export function words(s: string): string[] {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function lev(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

// «Похожие» слова: распознавание часто путает окончания, а актёр может слегка менять слова.
function similar(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4)) return true;
  const maxLen = Math.max(a.length, b.length);
  return maxLen >= 4 && lev(a, b) <= (maxLen >= 7 ? 2 : 1);
}

export interface Progress { matched: boolean[]; coverage: number; done: boolean }

export function matchLine(expectedText: string, heardText: string): Progress {
  const exp = words(expectedText);
  const heard = words(heardText);
  const matched = exp.map(() => false);
  let j = 0;
  for (let i = 0; i < exp.length; i++) {
    for (let k = j; k < heard.length; k++) {
      if (similar(exp[i], heard[k])) { matched[i] = true; j = k + 1; break; }
    }
  }
  const n = exp.length;
  const coverage = n ? matched.filter(Boolean).length / n : 1;
  const endHeard = matched[n - 1] || (n >= 3 && matched[n - 2]);
  // Реплика считается сказанной, если прозвучала бо́льшая часть слов и её конец.
  const done = (coverage >= 0.6 && endHeard) || coverage >= 0.85;
  return { matched, coverage, done };
}

// ---------- Обёртка над браузерным SpeechRecognition ----------

type SR = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  start: () => void; stop: () => void; abort: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
};

export function speechRecognitionSupported(): boolean {
  const w = window as unknown as Record<string, unknown>;
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export class Recognizer {
  private rec: SR | null = null;
  private wanted = false;
  private running = false;
  private base = 0;          // индекс результата, с которого начался текущий ход актёра
  private lastLen = 0;
  private sessionText = '';  // текст текущей сессии с начала хода
  private carry = '';        // текст хода из прошлых сессий (распознавание иногда перезапускается)
  failed = false;
  onText: (text: string) => void = () => {};
  onFatal: (code: string) => void = () => {};

  start() {
    this.wanted = true;
    if (this.running) return;
    const w = window as unknown as Record<string, new () => SR>;
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) { this.failed = true; this.onFatal('unsupported'); return; }
    if (!this.rec) {
      const r = new Ctor();
      r.lang = 'ru-RU';
      r.continuous = true;
      r.interimResults = true;
      r.maxAlternatives = 1;
      r.onstart = () => { this.running = true; this.base = 0; this.lastLen = 0; log('Распознавание: запущено'); };
      r.onresult = (e) => {
        this.lastLen = e.results.length;
        const parts: string[] = [];
        for (let i = this.base; i < e.results.length; i++) parts.push(e.results[i][0].transcript);
        this.sessionText = parts.join(' ');
        this.onText(this.text());
      };
      r.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        log(`Распознавание: ошибка ${e.error}`, 'warn');
        if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(e.error)) {
          this.failed = true;
          this.wanted = false;
          this.onFatal(e.error);
        }
      };
      r.onend = () => {
        this.running = false;
        this.carry = this.text();
        this.sessionText = '';
        if (this.wanted) {
          log('Распознавание: сессия закончилась, перезапускаю');
          setTimeout(() => this.restart(), 150);
        } else log('Распознавание: остановлено');
      };
      this.rec = r;
    }
    this.restart();
  }

  private restart() {
    if (!this.wanted || this.running || !this.rec) return;
    try { this.rec.start(); } catch (e) { log(`Распознавание: start() — ${String(e)}`, 'warn'); }
  }

  /** Начать новый ход актёра: всё услышанное раньше (в т.ч. голос партнёра) забываем. */
  newTurn() {
    this.base = this.lastLen;
    this.sessionText = '';
    this.carry = '';
  }

  text() { return `${this.carry} ${this.sessionText}`.trim(); }

  stop() {
    this.wanted = false;
    try { this.rec?.abort(); } catch { /* ok */ }
  }
}
