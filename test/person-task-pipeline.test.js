import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {BaseDir,ScreenshotIntervalSeconds} from '../src/const/index.js';
import {excludedFlags,findAbsentIntervals} from '../src/person-intervals.js';
import {calendarImagePath,imageInfo,compareImageNames} from '../src/image-timeline.js';
import {ScreenshotTaskManifest} from '../src/screenshot-task-manifest.js';
import {runTaskDetection,applyPersonIntervals} from '../src/person-task-pipeline.js';
import {organizeImagesByMonth} from '../src/organize-img-files.js';

async function fixture(t){const root=await fs.mkdtemp(path.join(BaseDir,'log','person-tasks-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const output=path.join(root,'output');await fs.mkdir(output);const file=path.join(root,'tasks.json');const options={intervalSeconds:ScreenshotIntervalSeconds,outputDir:output,flushIntervalMs:0};const manifest=await ScreenshotTaskManifest.open(file,options);return {root,output,file,options,manifest};}

test('absence requires ten negatives, expands both ways and preserves positive triplets',()=>{
 assert.deepEqual(findAbsentIntervals(Array(9).fill(false)),[]);
 const values=[true,true,true,false,true,...Array(10).fill(false),true,true,false,true,true,true];
 const flags=excludedFlags(values);
 assert.deepEqual(flags,values.map((_,i)=>i>=3&&i<=17));
});
test('unknown and failed results stop extension and never count as negative evidence',()=>{
 const values=[true,null,...Array(10).fill(false),null,false,true,true,true];
 assert.deepEqual(findAbsentIntervals(values),[{start:2,end:11}]);
});
test('calendar directory uses actual timestamp with cross-month and Windows filenames',()=>{
 const file='C:\\old\\20260630235959_20260701001000_0001_step_by_10s.jpg';
 assert.equal(imageInfo(file).month,'202607');
 assert.equal(calendarImagePath('/output',file),path.join('/output','2026','07','0701',imageInfo(file).name));
 assert.ok(compareImageNames('/z/20260101000000_20260101000100_0000_step_by_10s.jpg','/a/20260201000000_20260201000100_0000_step_by_10s.jpg')<0);
});
test('unified detection resumes without reinference and intervals span video boundaries',async t=>{
 const f=await fixture(t),videos=[path.join(f.root,'20260601000000_20260601000100.mp4'),path.join(f.root,'20260601000100_20260601000200.mp4')];
 f.manifest.startRun(videos);const files=[];
 for(const video of videos){f.manifest.prepareVideo(video,6*ScreenshotIntervalSeconds);for(let i=0;i<6;i++){const name=path.basename(video,'.mp4')+'_'+String(i).padStart(4,'0')+'_step_by_'+ScreenshotIntervalSeconds+'s.jpg';const file=path.join(f.output,name);await fs.writeFile(file,'image');files.push(file);f.manifest.markFrameComplete(video,i);}f.manifest.setPhase(video,'completed');}
 let calls=0;const detector={modelSha256:'fixture',detect:async()=>{calls++;return false;}};
 const first=await runTaskDetection({manifest:f.manifest,detector,files,month:'202606'});
 assert.equal(first.detected,12);assert.equal(first.excluded,12);await f.manifest.close();
 const again=await ScreenshotTaskManifest.open(f.file,f.options);
 const second=await runTaskDetection({manifest:again,detector,files,month:'202606'});assert.equal(second.cached,12);assert.equal(calls,12);
 again.startRun(videos);assert.equal(again.getVideo(videos[0]).excluded.filter(Boolean).length,6);assert.ok(again.getVideo(videos[0]).person.every(v=>v===false));await again.close();
});
test('excluded absent images satisfy generation completion without pretending files exist',async t=>{
 const f=await fixture(t),video=path.join(f.root,'20260601000000_20260601000300.mp4');f.manifest.startRun([video]);f.manifest.prepareVideo(video,12*ScreenshotIntervalSeconds);
 f.manifest.setExcluded(video,Array(12).fill(true));f.manifest.setPhase(video,'completed');assert.equal(f.manifest.getVideo(video).doneCount,0);assert.equal(f.manifest.snapshot.summary.skippedImages,12);assert.equal(f.manifest.snapshot.summary.pendingImages,0);await f.manifest.close();
 const again=await ScreenshotTaskManifest.open(f.file,f.options);again.startRun([video]);assert.equal(again.getVideo(video).completed,true);await again.close();
});
test('o2 organizes legacy flat and per-video images, is idempotent and never overwrites conflicts',async t=>{
 const f=await fixture(t);await f.manifest.close();const name='20260630235959_20260701001000_0001_step_by_10s.jpg';const old=path.join(f.output,'legacy-video');await fs.mkdir(old);await fs.writeFile(path.join(old,name),'existing');
 const result=await organizeImagesByMonth(f.output,'202607');assert.equal(result.moved,1);assert.equal(await fs.readFile(calendarImagePath(f.output,name),'utf8'),'existing');assert.equal((await organizeImagesByMonth(f.output,'202607')).moved,0);
 await fs.writeFile(path.join(f.output,name),'duplicate');const conflict=await organizeImagesByMonth(f.output,'202607');assert.equal(conflict.conflicts,1);assert.equal(await fs.readFile(calendarImagePath(f.output,name),'utf8'),'existing');assert.equal(await fs.readFile(path.join(f.output,name),'utf8'),'duplicate');
});


test('detector errors remain unknown and cached policy changes invalidate decisions',async t=>{
 const f=await fixture(t),video=path.join(f.root,'20260601000000_20260601000200.mp4');f.manifest.startRun([video]);f.manifest.prepareVideo(video,12*ScreenshotIntervalSeconds);
 const files=[];for(let i=0;i<12;i++){const file=path.join(f.output,path.basename(video,'.mp4')+'_'+String(i).padStart(4,'0')+'_step_by_'+ScreenshotIntervalSeconds+'s.jpg');await fs.writeFile(file,'image');files.push(file);}
 let index=0;const detector={modelSha256:'first',detect:async()=>{if(index++===5)throw Error('fixture error');return false;}};
 const result=await runTaskDetection({manifest:f.manifest,detector,files,month:'202606'});assert.equal(result.errors,1);assert.equal(result.excluded,0);assert.equal(f.manifest.getVideo(video).person[5],null);
 const changed={modelSha256:'second',detect:async()=>true};const next=await runTaskDetection({manifest:f.manifest,detector:changed,files,month:'202606'});assert.equal(next.detected,12);assert.equal(next.cached,0);assert.equal(next.excluded,0);await f.manifest.close();
});


test('relocating a missing project preserves video identity and person decisions',async t=>{
 const f=await fixture(t),video=path.join(f.root,'20260601000000_20260601000200.mp4');f.manifest.startRun([video]);f.manifest.prepareVideo(video,3*ScreenshotIntervalSeconds);
 for(let i=0;i<3;i++){f.manifest.markFrameComplete(video,i);f.manifest.markPersonResult(video,i,i!==1);}f.manifest.setPhase(video,'completed');await f.manifest.close();
 const data=JSON.parse(await fs.readFile(f.file,'utf8')),oldRoot=path.join(f.root,'missing-old-project'),row=Object.values(data.videos)[0];data.outputDirectory=path.join(oldRoot,'output');data.videos={[path.join(oldRoot,path.basename(video)).replaceAll('\\','/')]:row};await fs.writeFile(f.file,JSON.stringify(data));
 const again=await ScreenshotTaskManifest.open(f.file,f.options);again.startRun([video]);assert.equal(again.getVideo(video).completed,true);assert.deepEqual(again.getVideo(video).person,[true,false,true]);await again.close();
});
