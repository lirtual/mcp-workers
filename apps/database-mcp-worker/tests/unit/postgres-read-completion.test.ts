import {describe,expect,it,vi} from 'vitest';
import type {EffectiveConnection} from '../../src/types.js';
import {ConfirmedReadFailure,ConfirmedNoSqlFailure} from '../../src/db/completion.js';

const {clientConstructor}=vi.hoisted(()=>({clientConstructor:vi.fn()}));
vi.mock('pg',()=>({Client:class { constructor(config:unknown){return clientConstructor(config);} }}));
import {postgresQueryRead} from '../../src/db/postgres.js';

const connection: EffectiveConnection={
  config:{id:'synthetic',transport:'hyperdrive',configId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',bindingName:'HYPERDRIVE_TEST'},
  dialect:'postgres',transport:'hyperdrive',connectionString:'postgresql://redacted',
  host:'proxy.example.net',port:5432,user:'test',password:'synthetic',database:'app',
  limits:{maxRows:10,maxResultBytes:4096,maxSchemaBytes:4096,queryTimeoutMs:5000}
};

describe('PostgreSQL read completion evidence',()=>{
  it('marks a rejected connection handshake as pre-SQL without simulating rollback',async()=>{
    const end=vi.fn().mockResolvedValue(undefined);
    const query=vi.fn();
    clientConstructor.mockImplementation(()=>({connect:async()=>{throw Error('handshake refused');},query,end}));
    await expect(postgresQueryRead(connection,'SELECT 1',[],2))
      .rejects.toBeInstanceOf(ConfirmedNoSqlFailure);
    expect(query).not.toHaveBeenCalled();
  });
  it('reconciles a failed BEGIN READ ONLY only with same-session ROLLBACK evidence',async()=>{
    const query=vi.fn().mockImplementation(async(input:string|object)=>{
      if(input==='BEGIN READ ONLY')throw new Error('begin rejected');
      if(input==='ROLLBACK')return {rows:[],fields:[]};
      throw new Error('workload SQL must never execute');
    });
    clientConstructor.mockImplementation(()=>({
      connect:async()=>undefined,query,end:vi.fn().mockResolvedValue(undefined)
    }));
    await expect(postgresQueryRead(connection,'SELECT 1',[],2))
      .rejects.toBeInstanceOf(ConfirmedReadFailure);
    expect(query.mock.calls.map(call=>call[0])).toEqual(['BEGIN READ ONLY','ROLLBACK']);
    query.mockImplementation(async(input:string|object)=>{
      if(input==='ROLLBACK')throw new Error('rollback receipt missing');
      if(input==='BEGIN READ ONLY')throw new Error('begin rejected');
      throw new Error('workload SQL must never execute');
    });
    query.mockClear();
    await expect(postgresQueryRead(connection,'SELECT 1',[],2))
      .rejects.not.toBeInstanceOf(ConfirmedReadFailure);
    expect(query.mock.calls.map(call=>call[0])).toEqual(['BEGIN READ ONLY','ROLLBACK']);
  });
  it('only a completed ROLLBACK can establish a failed read is settled',async()=>{
    const failure=Object.assign(new Error('relation missing'),{code:'42P01'});
    const query=vi.fn().mockImplementation(async(input:string|object)=>{
      if(input==='BEGIN READ ONLY'||input==='ROLLBACK')return {rows:[],fields:[]};
      throw failure;
    });
    const end=vi.fn().mockResolvedValue(undefined);
    clientConstructor.mockImplementation(()=>({connect:async()=>undefined,query,end}));
    await expect(postgresQueryRead(connection,'SELECT * FROM missing',[],2))
      .rejects.toBeInstanceOf(ConfirmedReadFailure);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    query.mockImplementation(async(input:string|object)=>{
      if(input==='BEGIN READ ONLY')return {rows:[],fields:[]};
      if(input==='ROLLBACK')throw new Error('lost rollback acknowledgement');
      throw failure;
    });
    await expect(postgresQueryRead(connection,'SELECT * FROM missing',[],2))
      .rejects.not.toBeInstanceOf(ConfirmedReadFailure);
  });
});
