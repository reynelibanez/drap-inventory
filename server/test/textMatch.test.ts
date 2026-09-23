import { describe, expect, it } from 'vitest';
import { bestFuzzyMatch, levenshtein, normText } from '../src/services/textMatch.js';

describe('bestFuzzyMatch', () => {
  it('corrige errores leves de tipeo en texto sin números', () => {
    const candidates = [{ key: 'ThinkPad', item: 'tp' }, { key: 'Latitude', item: 'lat' }];
    expect(bestFuzzyMatch('Thinkpaad', candidates)).toEqual({ item: 'tp', exact: false });
  });

  it('encuentra coincidencia exacta ignorando mayúsculas y acentos', () => {
    const candidates = [{ key: 'Español', item: 'es' }];
    expect(bestFuzzyMatch('espanol', candidates)).toEqual({ item: 'es', exact: true });
  });

  it('NO confunde números de modelo distintos aunque se parezcan mucho (5410 vs 5400)', () => {
    const candidates = [{ key: '5400', item: 'm5400' }];
    expect(bestFuzzyMatch('5410', candidates)).toBeNull();
  });

  it('NO confunde generaciones distintas (10th Gen vs 11th Gen)', () => {
    const candidates = [{ key: '10th Gen', item: 'g10' }];
    expect(bestFuzzyMatch('11th Gen', candidates)).toBeNull();
  });

  it('sí corrige un error de tipeo en las letras alrededor de un número igual', () => {
    const candidates = [{ key: 'ThinkPad T480', item: 't480' }];
    expect(bestFuzzyMatch('Thinkpad T-480', candidates)).toEqual({ item: 't480', exact: false });
  });

  it('sin nada parecido, no hay coincidencia', () => {
    const candidates = [{ key: 'HP', item: 'hp' }];
    expect(bestFuzzyMatch('Newbrandz', candidates)).toBeNull();
  });
});

describe('levenshtein / normText', () => {
  it('distancia 0 para textos iguales', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
  });
  it('normText quita acentos y normaliza espacios', () => {
    expect(normText('  Español   Rápido ')).toBe('espanol rapido');
  });
});
