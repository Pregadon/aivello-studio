import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

// Хто підписав: людина (ключ на пристрої) чи посол (ключ на сервері).
export type SignerKind = 'human' | 'agent';

export interface KeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
}

export interface Signed<T> {
  payload: T;
  signer: SignerKind;
  signedAt: string;
  sig: string;
}

export function newKeyPair(): KeyPair {
  return generateKeyPairSync('ed25519');
}

// Стабільний JSON: ключі відсортовано, щоб підпис не залежав від порядку полів.
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

function bytesToSign(payload: unknown, signer: SignerKind, signedAt: string): Buffer {
  return Buffer.from(canonical({ payload, signer, signedAt }));
}

export function signAs<T>(signer: SignerKind, payload: T, privateKey: KeyObject, now = new Date()): Signed<T> {
  const signedAt = now.toISOString();
  const sig = sign(null, bytesToSign(payload, signer, signedAt), privateKey).toString('base64');
  return { payload, signer, signedAt, sig };
}

// Перевіряє і підпис, і вид підписувача: підпис посла ніколи не пройде як людський.
export function verifySigned<T>(s: Signed<T>, publicKey: KeyObject, expected: SignerKind): boolean {
  if (s.signer !== expected) return false;
  try {
    return verify(null, bytesToSign(s.payload, s.signer, s.signedAt), publicKey, Buffer.from(s.sig, 'base64'));
  } catch {
    return false;
  }
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface SealPayload {
  contentHash: string;
  author: string;
}

// Печатка людини на тексті. Ставиться лише ключем людини на її пристрої.
export function sealByHuman(text: string, author: string, humanKey: KeyObject, now = new Date()): Signed<SealPayload> {
  return signAs('human', { contentHash: contentHash(text), author }, humanKey, now);
}

export function checkSeal(text: string, seal: Signed<SealPayload>, humanPublicKey: KeyObject): boolean {
  return seal.payload.contentHash === contentHash(text) && verifySigned(seal, humanPublicKey, 'human');
}
