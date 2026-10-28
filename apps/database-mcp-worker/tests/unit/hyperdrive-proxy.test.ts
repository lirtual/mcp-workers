import { describe, expect, it } from 'vitest';
import { hyperdriveProxyFields, mysqlHyperdriveSchema } from '../../src/db/hyperdrive.js';

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

describe('MySQL Hyperdrive origin schema identity', () => {
  it('uses reviewed origin schema for SQL while retaining opaque proxy handshake database', () => {
    expect(mysqlHyperdriveSchema('opaque-proxy-db', 'database-mcp-test-mysql')).toEqual({
      database: 'database-mcp-test-mysql', proxyDatabase: 'opaque-proxy-db'
    });
  });
  it('rejects invalid or absent reviewed origin schema', () => {
    for (const invalid of [undefined, '', '../wrong', 'bad\u0000name', 1]) {
      expect(() => mysqlHyperdriveSchema('opaque-proxy-db', invalid)).toThrowError(/schema/);
    }
  });
});
