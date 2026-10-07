import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreparedQueue} from '../src/person-prepared-queue.js';
test('bounded preparation prefetches, returns every image once and stops on abort',async()=>{
 let prepared=0;const controller=new AbortController();
 const workers=Array.from({length:3},()=>({async prepare(file){prepared++;return {pixels:Buffer.from(file)};}}));
 const queue=createPreparedQueue(Array.from({length:12},(_,i)=>({file:String(i)})),workers,32,2,controller.signal);
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(prepared,2);
 const seen=[];for(let i=0;i<12;i++)seen.push((await queue.take()).file);
 assert.equal(new Set(seen).size,12);assert.equal(await queue.take(),undefined);await queue.close();
 const stopped=createPreparedQueue([{file:'one'},{file:'two'}],workers,32,1,controller.signal);controller.abort();assert.equal(await stopped.take(),undefined);await stopped.close();
});
test('preparation errors reach the consumer and fatal worker exits terminate the queue',async()=>{
 const failed=createPreparedQueue([{file:'bad'}],[{async prepare(){throw Error('invalid JPEG');}}],32,1);assert.match((await failed.take()).error.message,/JPEG/);await failed.close();
 const dead=createPreparedQueue([{file:'bad'}],[{async prepare(){throw Object.assign(Error('exit'),{workerExited:true});}}],32,1);await assert.rejects(dead.take(),/exit/);await dead.close();
});
