import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import * as Const from './const/index.js';
import {ScreenshotTaskManifest} from './screenshot-task-manifest.js';
import {imageInfo,walkImages,compareImageNames} from './image-timeline.js';
import {excludedFlags} from './person-intervals.js';
import {acquireTaskLock} from './task-lock.js';

export function applyPersonIntervals(manifest, absentCount, presentCount) {
 const rows=[];
 for(const [uri,video] of Object.entries(manifest.snapshot.videos)){
  if(video.phase==='ignored')continue;
  const stem=path.basename(video.fileName,path.extname(video.fileName));
  for(let i=0;i<video.frames.length;i++)rows.push({uri,index:i,name:stem+'_'+String(i).padStart(4,'0')+'_step_by_'+manifest.intervalSeconds+'s.jpg',person:video.person?.[i]??null});
 }
 rows.sort((a,b)=>compareImageNames(a.name,b.name));
 const excluded=excludedFlags(rows.map(row=>row.person),absentCount,presentCount),flags=new Map();
 for(const [uri,video] of Object.entries(manifest.snapshot.videos))flags.set(uri,video.frames.map(()=>false));
 rows.forEach((row,i)=>{flags.get(row.uri)[row.index]=excluded[i];});
 for(const [uri,value]of flags)manifest.setExcluded(uri,value);
 return excluded.filter(Boolean).length;
}

export async function runTaskDetection({manifest,detector,files,month,signal,onProgress=()=>{}}) {
 Const.validatePersonConfig();
 const policy={version:1,modelSha256:detector.modelSha256,confidence:Const.PersonConfidence,preprocessVersion:1,interval:Const.ScreenshotIntervalSeconds,absentRun:Const.PersonAbsentRun,presentRun:Const.PersonPresentRun};
 manifest.setPersonPolicy(policy);
 const byStem=new Map(Object.entries(manifest.snapshot.videos).filter(([,v])=>v.phase!=='ignored').map(([uri,v])=>[path.basename(v.fileName,path.extname(v.fileName)),uri]));
 const selected=files.filter(file=>{const info=imageInfo(file);return info&&info.interval===Const.ScreenshotIntervalSeconds&&info.month===month&&byStem.has(info.stem);}).sort(compareImageNames);
 const counts={selected:selected.length,processed:0,detected:0,cached:0,errors:0};
 manifest.setDetectionRun({state:'running',month,...counts});
 for(const file of selected){
  if(signal?.aborted)break;
  const info=imageInfo(file),uri=byStem.get(info.stem),video=manifest.getVideo(uri);
  if(info.index>=video.frames.length)continue;
  try{
   if(typeof video.person?.[info.index]==='boolean')counts.cached++;
   else{const stat=await fs.stat(file);if(!stat.isFile()||stat.size<=0)throw new Error('图片无效');manifest.markPersonResult(uri,info.index,await detector.detect(file));counts.detected++;}
  }catch(error){counts.errors++;manifest.markPersonResult(uri,info.index,null);manifest.setDetectionRun({lastError:file+': '+error.message});}
  counts.processed++;
  manifest.setDetectionRun(counts);
  if(counts.processed%100===0){onProgress(counts);await manifest.flush();}
 }
 const excluded=applyPersonIntervals(manifest,Const.PersonAbsentRun,Const.PersonPresentRun);
 manifest.setDetectionRun({state:signal?.aborted?'cancelled':counts.errors?'failed':'completed',...counts,excluded});
 await manifest.flush();
 return {...counts,excluded};
}

export async function main(argv=process.argv.slice(2)) {
 let month=Const.TargetMonth;
 for(let i=0;i<argv.length;i++){if(argv[i]==='--')continue;if(argv[i]==='--month')month=argv[++i];else if(argv[i]==='--help'){console.log('pnpm detect-person --tasks [--month YYYYMM]：检测已有截图，更新 screenshot-tasks.json 的人员结果及无人区间；可中断后续跑。');return;}else throw new Error('未知任务检测参数: '+argv[i]);}
 if(!/^\d{4}(0[1-9]|1[0-2])$/.test(month??''))throw new Error('月份必须为 YYYYMM');
 const release=await acquireTaskLock(Const.ScreenshotTaskManifestPath);
 let manifest,detector;
 const controller=new AbortController(),stop=()=>controller.abort();
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  manifest=await ScreenshotTaskManifest.open(Const.ScreenshotTaskManifestPath,{intervalSeconds:Const.ScreenshotIntervalSeconds,outputDir:Const.OutputImgDir,onSnapshot:async text=>{const {writeTaskProgressHtml}=await import('./task-progress-html.js');await writeTaskProgressHtml(Const.TaskProgressHtmlPath,text);}});
  if(!Object.keys(manifest.snapshot.videos).length)throw new Error('请先运行 pnpm m1 建立截图任务清单');
  if(manifest.snapshot.screenshotIntervalSeconds!==Const.ScreenshotIntervalSeconds)throw new Error('任务清单截图间隔与配置不同，请先运行 m1');
  const {createPersonDetector}=await import('./person-detector.js');
  detector=await createPersonDetector({confidence:Const.PersonConfidence});
  const files=[];for await(const file of walkImages(Const.OutputImgDir,fs)){const info=imageInfo(file);if(info?.month===month&&info.interval===Const.ScreenshotIntervalSeconds)files.push(file);}
  const result=await runTaskDetection({manifest,detector,files,month,signal:controller.signal,onProgress:counts=>console.log('人员检测进度',JSON.stringify(counts))});
  console.log('人员检测完成',JSON.stringify(result));
  if(controller.signal.aborted)process.exitCode=130;else if(result.errors)process.exitCode=1;
 }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);try{await detector?.close();await manifest?.close();}finally{await release();}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
