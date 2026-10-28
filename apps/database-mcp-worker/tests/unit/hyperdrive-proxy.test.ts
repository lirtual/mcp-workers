import { describe, expect, it } from 'vitest';
import { hyperdriveProxyFields } from '../../src/db/hyperdrive.js';

const proxy = {
  connectionString: 'mysql://proxy:secret@synthetic.proxy.internal/db?sslmode=require',
  host: 'worker-proxy.internal', port: 3306,
  user: 'proxy+encoded@example', password: 'p@ss:word/with?reserved',
  database: 'test-db'
};
describe('Hyperdrive runtime proxy binding', () => {
  it('uses Cloudflare structured connection fields, not untrusted URL query overrides', () => {
    expect(hyperdriveProxyFields(proxy)).toEqual(proxy);
    expect(hyperdriveProxyFields({...proxy, connectionString:'postgres://wrong-user@different.example/other?sslmode=disable'}))
      .toMatchObject({host:'worker-proxy.internal',user:'proxy+encoded@example',password:proxy.password,database:'test-db'});
  });
  it('fails closed on incomplete proxy identity', () => {
    for (const invalid of [
      undefined, {}, {...proxy,connectionString:''}, {...proxy,host:''},
      {...proxy,port:0}, {...proxy,port:'3306'}, {...proxy,port:65536},
      {...proxy,user:''}, {...proxy,password:''}, {...proxy,database:''}
    ]) expect(() => hyperdriveProxyFields(invalid)).toThrowError(/Hyperdrive binding/);
  });
});
