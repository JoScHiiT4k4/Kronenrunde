// Schimpfwortfilter für den Chat: Wörter werden durch Sterne ersetzt (Länge bleibt gleich). Reine Logik.

/** Teile von Wörtern, die in jedem Wort vorkommen dürfen (lang genug, um kaum Treffer in harmlosen Wörtern zu haben). */
const STEMS = [
  'scheiss', 'scheiß', 'arschloch', 'arschgeige', 'fotze', 'wichser', 'wixer', 'hurensohn', 'hurenkind', 'fick', 'schlampe', 'spast',
  'fuck', 'shit', 'bitch', 'bastard', 'asshole', 'dickhead', 'cunt', 'motherfucker', 'wanker', 'bullshit', 'dumbass', 'jackass', 'nigg', 'fagg',
];
/** Kurze Wörter nur als ganzes Wort (sonst Treffer in "Passage", "Hurrikan" …). */
const WORDS = new Set(['arsch', 'ass', 'hure', 'nutte', 'piss', 'pisser', 'kacke', 'kack', 'depp', 'trottel', 'mongo', 'idiot', 'idioten', 'penner', 'schwuchtel', 'dick', 'pussy', 'slut', 'whore', 'crap', 'damn', 'noob']);

const fold = (w: string) => w.toLowerCase().replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss').replace(/[^a-z]/g, '');
const STEM_KEYS = STEMS.map(fold);

function bad(word: string): boolean {
  const w = fold(word);
  if (w.length < 3) return false;
  return WORDS.has(w) || STEM_KEYS.some((s) => w.includes(s));
}

/** Ersetzt Schimpfwörter durch Sterne, z. B. "Du Arsch" → "Du *****". */
export function maskProfanity(text: string): string {
  return text.replace(/[\p{L}]+(?:[-'’][\p{L}]+)*/gu, (word) => (bad(word) ? '*'.repeat([...word].length) : word));
}
