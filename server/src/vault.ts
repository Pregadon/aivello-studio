import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Шифрує ключі послів майстер-ключем сервера. Без майстер-ключа витік бази не дає підписувати від імені послів.
// Ідентифікатор посольства входить у перевірку (AAD): ключ одного посольства не підставити іншому.
export class Vault {
  key: Buffer;

  constructor(masterKeyHex: string) {
    if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) throw new Error('POSOL_MASTER_KEY має бути 32 байти в hex (64 символи)');
    this.key = Buffer.from(masterKeyHex, 'hex');
  }

  seal(plain: string, embassy: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(embassy));
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv, c.getAuthTag(), body].map((x) => (typeof x === 'string' ? x : x.toString('base64url'))).join('.');
  }

  open(sealed: string, embassy: string): string {
    const [v, iv, tag, body] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !body) throw new Error('Невідомий формат зашифрованого ключа');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(embassy));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    try {
      return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
    } catch {
      throw new Error(`Не вдалося розшифрувати ключ посла ${embassy}: інший POSOL_MASTER_KEY або пошкоджені дані`);
    }
  }
}
