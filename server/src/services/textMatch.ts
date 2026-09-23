/**
 * Comparación de texto "aproximada" para importaciones: corrige errores leves de tipeo (mayúsculas, acentos,
 * espacios de más, una letra cambiada) contra los valores que ya existen en un catálogo, sin inventar nada que
 * no se parezca de verdad al original.
 */

/** Distancia de edición (Levenshtein) entre dos textos. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array<number>(bl + 1);
  let cur = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[bl];
}

/** Quita acentos, pasa a minúsculas y normaliza espacios, para que la comparación no falle por eso. */
export function normText(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Solo los dígitos de un texto, en orden (p. ej. "840 G3" -> "8403"). */
function digitsOf(s: string): string {
  return s.replace(/\D/g, '');
}

export interface FuzzyCandidate<T> { key: string; item: T }
export interface FuzzyResult<T> { item: T; exact: boolean }

/**
 * Mejor coincidencia de `raw` contra una lista de candidatos (cada uno puede tener varias formas de nombre,
 * p. ej. español e inglés). Si hay una igual exacta (sin importar mayúsculas/acentos) se usa esa; si no, se acepta
 * la más parecida solo si el error es leve (hasta ~25% de la longitud del texto), como para corregir un tipeo.
 * Si nada se parece lo suficiente, no hay coincidencia (habrá que crear el valor).
 *
 * Excepción importante: si el texto tiene dígitos (números de modelo, generación, etc.), un cambio de dígito
 * NUNCA se trata como error de tipeo — "5410" y "5400" son modelos distintos, no un typo el uno del otro — así
 * que solo se acepta la coincidencia difusa cuando los dígitos son exactamente iguales (las letras alrededor sí
 * pueden variar levemente, p. ej. "ThinkPad T480" vs "Thinkpad T-480").
 */
export function bestFuzzyMatch<T>(raw: string, candidates: FuzzyCandidate<T>[]): FuzzyResult<T> | null {
  const q = normText(raw);
  if (!q) return null;
  const qDigits = digitsOf(q);
  let best: { item: T; dist: number } | null = null;
  for (const c of candidates) {
    const k = normText(c.key);
    if (!k) continue;
    if (k === q) return { item: c.item, exact: true };
    const kDigits = digitsOf(k);
    if (qDigits !== kDigits) continue; // números distintos: no es un simple error de tipeo
    const dist = levenshtein(q, k);
    const threshold = Math.max(1, Math.floor(Math.max(q.length, k.length) * 0.25));
    if (dist <= threshold && (!best || dist < best.dist)) best = { item: c.item, dist };
  }
  return best ? { item: best.item, exact: false } : null;
}
