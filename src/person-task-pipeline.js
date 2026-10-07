import {createPreparedQueue} from './person-prepared-queue.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import * as Const from './const/index.js';
import {ScreenshotTaskManifest} from './screenshot-task-manifest.js';
import {imageInfo,walkImages,compareImageNames} from './image-timeline.js';
import {excludedFlags} from './person-intervals.js';
import {acquireTaskLock} from './task-lock.js';

export async function scanMonthImages(root, month, interval, {signal, onProgress = () => {}} = {}) {
 const monthDirectory=path.join(root,month.slice(0,4),month.slice(4,6));
 let directory=root,legacyFallback=false;
 try {const stat=await fs.stat(monthDirectory);if(!stat.isDirectory())throw new Error('月份路径不是目录: '+monthDirectory);directory=monthDirectory;}
 catch(error){if(error.code!=='ENOENT')throw error;legacyFallback=true;}
 onProgress({directory,legacyFallback,scanned:0,matched:0});
 const files=[];let scanned=0,lastLog=Date.now();
 for await(const file of walkImages(directory,fs)) {
  signal?.throwIfAborted();scanned++;
  const info=imageInfo(file);if(info?.month===month&&info.interval===interval)files.push(file);
  if(Date.now()-lastLog>=3000){onProgress({directory,legacyFallback,scanned,matched:files.length});lastLog=Date.now();}
 }
 onProgress({directory,legacyFallback,scanned,matched:files.length,complete:true});
 return files;
}

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

export async function runTaskDetection({manifest,detector,detectors,preprocessors,files,month,signal,onProgress=()=>{}}) {
 Const.validatePersonConfig();
 const sessions=detectors ?? [detector];
 if(!sessions.length || sessions.some(session=>!session || typeof session.detect!=='function'))throw new Error('没有可用检测 worker');
 if(sessions.some(session=>session.modelSha256!==sessions[0].modelSha256))throw new Error('检测 worker 模型不一致');
 const policy={version:1,modelSha256:sessions[0].modelSha256,confidence:Const.PersonConfidence,preprocessVersion:1,interval:Const.ScreenshotIntervalSeconds,absentRun:Const.PersonAbsentRun,presentRun:Const.PersonPresentRun};
 manifest.setPersonPolicy(policy);
 const byStem=new Map(Object.entries(manifest.snapshot.videos).filter(([,v])=>v.phase!=='ignored').map(([uri,v])=>[path.basename(v.fileName,path.extname(v.fileName)),uri]));
 const seen=new Set();
 const selected=files.filter(file=>{
   const info=imageInfo(file);if(!info || info.interval!==Const.ScreenshotIntervalSeconds || info.month!==month || !byStem.has(info.stem))return false;
   const key=info.stem+':'+info.index;if(seen.has(key))return false;seen.add(key);return info.index<manifest.getVideo(byStem.get(info.stem)).frames.length;
 }).sort(compareImageNames);
 const pending=[];
 for(const file of selected){const info=imageInfo(file),uri=byStem.get(info.stem);if(typeof manifest.getVideo(uri).person?.[info.index]!=='boolean')pending.push({file,uri,index:info.index});}
 const cached=selected.length-pending.length;
 const counts={selected:selected.length,processed:cached,detected:0,cached,errors:0};
 const workers=sessions.map((session,index)=>({id:'person-worker-'+(index+1),provider:session.provider??'fixture',pid:session.pid,preprocessSeconds:0,inferenceSeconds:0,processed:0,detected:0,cached:0,errors:0,workingSeconds:0}));
 const preparedQueue=preprocessors?.length?createPreparedQueue(pending,preprocessors,sessions[0].inputSize,Const.PersonPreparedQueueCapacity,signal):null;
 let next=0,lastDetectionLog=Date.now();
 manifest.setDetectionRun({state:'running',month,...counts,workers});
 onProgress({...counts,pending:pending.length,workers:workers.map(worker=>({...worker}))});
 const results=await Promise.allSettled(sessions.map(async(session,workerIndex)=>{
  const worker=workers[workerIndex];
  while(!signal?.aborted){
   // Synchronous claim: each image is owned by exactly one independent session.
   const item=preparedQueue?await preparedQueue.take():pending[next++];if(!item)break;
   const {file,uri,index,prepared,error:prepareError}=item,started=performance.now();
   try {
    if(prepareError)throw prepareError;
    if(!prepared){const stat=await fs.stat(file);if(!stat.isFile()||stat.size<=0)throw new Error('图片无效');}
    const details=prepared?await session.inferPrepared(prepared.pixels):session.inspect?await session.inspect(file):{hasPerson:await session.detect(file)};const result=details.hasPerson;worker.inferenceSeconds+=(details.inferenceMs??0)/1000;worker.preprocessSeconds+=(prepared?.preprocessMs??0)/1000;worker.preprocessSeconds+=Math.max(0,(details.totalMs??0)-(details.inferenceMs??0))/1000;manifest.markPersonResult(uri,index,result);counts.detected++;worker.detected++;
   } catch(error){if(error.workerExited)throw error;counts.errors++;worker.errors++;manifest.markPersonResult(uri,index,null);manifest.setDetectionRun({lastError:file+': '+error.message});}
   counts.processed++;worker.processed++;worker.workingSeconds+=(performance.now()-started)/1000;
   manifest.setDetectionRun({...counts,workers,preprocessWorkers:preparedQueue?.stats});
   if(Date.now()-lastDetectionLog>=3000){lastDetectionLog=Date.now();onProgress({...counts,workers:workers.map(value=>({...value,workingSeconds:Number(value.workingSeconds.toFixed(1))}))});await manifest.flush();}
  }
 }));
 await preparedQueue?.close();
 const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
 // Completion order does not influence temporal rules: intervals are computed in filename order.
 const excluded=applyPersonIntervals(manifest,Const.PersonAbsentRun,Const.PersonPresentRun);
 manifest.setDetectionRun({state:signal?.aborted?'cancelled':counts.errors?'failed':'completed',...counts,excluded,workers});
 await manifest.flush();
 return {...counts,excluded,workers};
}

export async function main(argv=process.argv.slice(2)) {
 let month=Const.TargetMonth;
 for(let i=0;i<argv.length;i++){if(argv[i]==='--')continue;if(argv[i]==='--month')month=argv[++i];else if(argv[i]==='--help'){console.log('pnpm detect-person --tasks [--month YYYYMM]：检测已有截图，更新 screenshot-tasks.json 的人员结果及无人区间；可中断后续跑。');return;}else throw new Error('未知任务检测参数: '+argv[i]);}
 if(!/^\d{4}(0[1-9]|1[0-2])$/.test(month??''))throw new Error('月份必须为 YYYYMM');
 const release=await acquireTaskLock(Const.ScreenshotTaskManifestPath);
 let manifest;const detectors=[],preprocessors=[];
 const controller=new AbortController(),stop=()=>controller.abort();
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  manifest=await ScreenshotTaskManifest.open(Const.ScreenshotTaskManifestPath,{intervalSeconds:Const.ScreenshotIntervalSeconds,outputDir:Const.OutputImgDir,onSnapshot:async text=>{const {writeTaskProgressHtml}=await import('./task-progress-html.js');await writeTaskProgressHtml(Const.TaskProgressHtmlPath,text);}});
  if(!Object.keys(manifest.snapshot.videos).length)throw new Error('请先运行 pnpm m1 建立截图任务清单');
  if(manifest.snapshot.screenshotIntervalSeconds!==Const.ScreenshotIntervalSeconds)throw new Error('任务清单截图间隔与配置不同，请先运行 m1');
  console.log("人员检测月份:",month,"，图片目录:",Const.OutputImgDir);
  const matchingTasks=Object.values(manifest.snapshot.videos).filter(video=>video.fileName.slice(0,6)<=month && video.fileName.slice(15,21)>=month);
  if (!matchingTasks.length) throw new Error("任务 JSON 中没有与 "+month+" 相交的视频记录，请先运行 pnpm m1 --month "+month+" 建立任务，已有图片会命中缓存");
  console.log("匹配视频任务:",matchingTasks.length,"，初始化人员检测模型...");
  const {createPersonProcessDetector}=await import('./person-process-detector.js');
  Const.validatePersonConfig();
  for(let i=0;i<Const.PersonDetectionConcurrency;i++){controller.signal.throwIfAborted();const detector=await createPersonProcessDetector({confidence:Const.PersonConfidence});detectors.push(detector);console.log("检测 worker:","person-worker-"+(i+1),"，PID:",detector.pid,"，设备:",detector.provider);}
  for(let i=0;i<Const.PersonPreprocessConcurrency;i++){controller.signal.throwIfAborted();const worker=await createPersonProcessDetector({}, {role:'preprocess'});preprocessors.push(worker);console.log("预处理 worker:","preprocess-worker-"+(i+1),"，PID:",worker.pid);}
  console.log("开始递归扫描月份图片，共",detectors.length,"个独立检测进程");
  const files=await scanMonthImages(Const.OutputImgDir,month,Const.ScreenshotIntervalSeconds,{signal:controller.signal,onProgress:progress=>{
    if(progress.scanned===0&&!progress.complete)console.log('扫描目录:',progress.directory,progress.legacyFallback?'（月份目录不存在，兼容旧目录扫描）':'（仅本月目录）');
    else console.log(progress.complete?'扫描完成:':'图片扫描进度:',progress.scanned,'张，月份及间隔匹配',progress.matched,'张');
  }});
  if (!files.length) throw new Error("未找到 "+month+" 月匹配截图间隔的图片，请先运行 pnpm m1 --month "+month);
  const result=await runTaskDetection({manifest,detectors,preprocessors,files,month,signal:controller.signal,onProgress:counts=>console.log('人员检测进度',JSON.stringify(counts))});
  console.log('人员检测完成',JSON.stringify(result));
  if(controller.signal.aborted)process.exitCode=130;else if(result.errors)process.exitCode=1;
 }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);try{const closed=await Promise.allSettled([...detectors,...preprocessors].map(detector=>detector.close()));await manifest?.close();const error=closed.find(result=>result.status==="rejected");if(error)throw error.reason;}finally{await release();}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
