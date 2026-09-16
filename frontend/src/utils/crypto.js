const PASS = '0ch-messenger-key-2026-v2';

async function key() {
  const enc = new TextEncoder();
  const mat = await crypto.subtle.importKey('raw', enc.encode(PASS), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('0ch-salt'), iterations: 100000, hash: 'SHA-256' },
    mat, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

export async function encryptMessage(text) {
  if (!text) return text;
  try {
    const k = await key();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const c = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(text));
    const buf = new Uint8Array(iv.length + c.byteLength);
    buf.set(iv); buf.set(new Uint8Array(c), 12);
    return btoa(String.fromCharCode(...buf));
  } catch { return text; }
}

export async function decryptMessage(ct) {
  if (!ct || !/^[A-Za-z0-9+/=]+$/.test(ct) || ct.length < 20) return ct;
  try {
    const buf = Uint8Array.from(atob(ct), c => c.charCodeAt(0));
    const k = await key();
    const p = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, k, buf.slice(12));
    return new TextDecoder().decode(p);
  } catch { return ct; }
}
