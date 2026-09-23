/**
 * Copia texto al portapapeles. Usa la API moderna (requiere https o localhost) y, si no está disponible
 * —por ejemplo al entrar desde otra PC por http://IP:3000—, un método alternativo que funciona igual.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* se intenta el método alternativo */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

/** Lee el portapapeles (solo donde el navegador lo permite); devuelve null si no se puede. */
export async function pasteText(): Promise<string | null> {
  try {
    if (navigator.clipboard?.readText && window.isSecureContext) return await navigator.clipboard.readText();
  } catch { /* sin permiso */ }
  return null;
}
