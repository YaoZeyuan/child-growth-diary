import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPersonProcessDetector} from '../src/person-process-detector.js';

test('independent detector processes return results and close cleanly',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'person-process-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const module=path.join(root,'fixture.mjs'),image=path.join(root,'image.jpg');await fs.writeFile(image,'fixture');
 await fs.writeFile(module,"export async function createPersonDetector(){return {provider:'fixture',modelSha256:'fixture',async inspect(){await new Promise(resolve=>setTimeout(resolve,50));return {hasPerson:true,inferenceMs:10,totalMs:20,pid:process.pid};},async close(){}}}");
 const workers=[];t.after(()=>Promise.allSettled(workers.map(worker=>worker.close())));
 for(let i=0;i<3;i++)workers.push(await createPersonProcessDetector({}, {detectorModule:pathToFileURL(module).href}));
 assert.equal(new Set(workers.map(worker=>worker.pid)).size,3);assert.ok(workers.every(worker=>worker.pid!==process.pid));
 const results=await Promise.all(workers.map(worker=>worker.inspect(image)));assert.ok(results.every((value,i)=>value.hasPerson&&value.pid===workers[i].pid));
 await assert.rejects(workers[0].detect(path.join(root,'missing.jpg')));assert.equal(await workers[0].detect(image),true);
 await Promise.all(workers.map(worker=>worker.close()));await assert.rejects(workers[0].detect(image));
});

test('unexpected child exit rejects an in-flight request',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'person-process-exit-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const module=path.join(root,'fixture.mjs'),image=path.join(root,'image.jpg');await fs.writeFile(image,'fixture');
 await fs.writeFile(module,"export async function createPersonDetector(){return {provider:'fixture',modelSha256:'fixture',async inspect(){process.exit(2);},async close(){}}}");
 const worker=await createPersonProcessDetector({}, {detectorModule:pathToFileURL(module).href});t.after(()=>worker.close());await assert.rejects(worker.inspect(image),/子进程退出/);
});
