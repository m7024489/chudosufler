export type Who = 'partner' | 'actor';
export interface Line { who: Who; name: string; text: string }

// Тестовая сцена из ТЗ. Актёр играет Машу, суфлёр озвучивает Петю.
export const SCENE: Line[] = [
  { who: 'partner', name: 'ПЕТЯ', text: 'Ты действительно собираешься уехать?' },
  { who: 'actor', name: 'МАША', text: 'Да. Я больше не могу здесь оставаться.' },
  { who: 'partner', name: 'ПЕТЯ', text: 'А как же всё, что между нами было?' },
  { who: 'actor', name: 'МАША', text: 'Я ничего не забыла. Но мне нужно двигаться дальше.' },
  { who: 'partner', name: 'ПЕТЯ', text: 'Тогда скажи мне это в глаза.' },
];

export const PARTNER_INDEXES = SCENE.map((l, i) => (l.who === 'partner' ? i : -1)).filter((i) => i >= 0);
