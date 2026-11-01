import { describe, expect, it } from 'vitest';
import { normalizeConnectionInput } from '../../src/setup/connection-input.js';

const submit = (values: Record<string,string>) => new URLSearchParams(values);

describe('single Owner connection form', () => {
  it('normalizes encoded URL and separate fields to the same credentials and target', () => {
    const url = normalizeConnectionInput(submit({input_mode:'url',url:'postgresql://john%40example:p%40ss%3Aword@db.example.net/catalog'}), 'postgres', 'direct');
    const fields = normalizeConnectionInput(submit({input_mode:'fields',host:'db.example.net',database:'catalog',username:'john@example',password:'p@ss:word'}), 'postgres','direct');
    expect(url).toEqual(fields);
    expect(url.port).toBe(5432);
    expect(url.url).not.toContain('sslmode');
  });
  it('defaults MySQL to port 3306 and rejects conflicting or untrusted URL options', () => {
    expect(normalizeConnectionInput(submit({input_mode:'fields',host:'db.example.net',database:'app',username:'u',password:'p'}),'mysql','direct').port).toBe(3306);
    for (const url of [
      'postgres://u:p@db.example.net/app?sslmode=require',
      'postgres://u:p@db.example.net/app?sslmode=verify-full',
      'postgres://u:p@db.example.net/app?rejectUnauthorized=false',
      'postgres://u:p@db.example.net/app?sslmode=disable&sslmode=disable'
    ]) expect(() => normalizeConnectionInput(submit({input_mode:'url',url}),'postgres','direct')).toThrow();
  });
  it('Hyperdrive only accepts strict-compatible SSL hints, never user-driven downgrade', () => {
    expect(normalizeConnectionInput(submit({input_mode:'url',url:'mysql://u:p@db.example.net/app?sslmode=require'}),'mysql','hyperdrive').url).not.toContain('sslmode');
    for(const sslmode of ['disable','prefer','allow'])
      expect(() => normalizeConnectionInput(submit({input_mode:'url',url:`mysql://u:p@db.example.net/app?sslmode=${sslmode}`}),'mysql','hyperdrive')).toThrow();
  });
  it('uses only the selected mode after switching back and forth without clearing hidden fields', () => {
    const url = 'mysql://u:p@db.example.net/app';
    const staleFields = {host:'old.example.net',port:'9999',database:'old',username:'old',password:'stale'};
    const fromUrl = normalizeConnectionInput(submit({input_mode:'url',url,...staleFields}),'mysql','direct');
    expect(fromUrl.host).toBe('db.example.net');
    expect(fromUrl.password).toBe('p');
    const fields = normalizeConnectionInput(submit({input_mode:'fields',url:'mysql://bad:stale@old.example.net/old',
      host:'db.example.net',database:'app',username:'u',password:'p'}),'mysql','direct');
    expect(fields).toEqual(fromUrl);
    expect(() => normalizeConnectionInput(submit({input_mode:'url',url}),'postgres','direct')).toThrow();
    expect(() => normalizeConnectionInput(submit({input_mode:'url',url:'mysql://u:p@db.example.net/app?sslmode=prefer'}),
      'mysql','hyperdrive')).toThrow();
    expect(() => normalizeConnectionInput(submit({input_mode:'fields',url,host:'db.example.net',database:'app',username:'u',password:'p',port:'bad'}),
      'mysql','direct')).toThrow();
  });
});