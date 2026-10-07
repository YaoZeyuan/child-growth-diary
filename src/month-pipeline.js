import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import * as Const from './const/index.js';

export function parseMonthPipelineArgs(argv) {
 const options={month:Const.TargetMonth,yes:false};
 for(let i=0;i<argv.length;i++){if(argv[i]==='--')continue;if(argv[i]==='--month')options.month=argv[++i];else if(argv[i]==='--yes')options.yes=true;else if(argv[i]==='--help'||argv[i]==='-h')options.help=true;else throw new Error('未知参数: '+argv[i]);}
 if(!/^\d{4}(0[1-9]|1[0-2])$/.test(options.month??''))throw new Error('月份必须为 YYYYMM');return options;
}
export function monthPipelineSteps(month){return [
 {name:'生成月份图片',script:'monitor-video-2-img.js',args:['--month',month,'--yes']},
 {name:'检测人员与无人区间',script:'detect-person.js',args:['--tasks','--month',month]},
 {name:'合成月份视频',script:'screenshot-2-video.js',args:['--month',month,'--yes']},
];}
export async function executeMonthPipeline(month,run,signal){for(const step of monthPipelineSteps(month)){signal?.throwIfAborted();const code=await run(step);if(signal?.aborted)signal.throwIfAborted();if(code!==0)throw new Error(step.name+'失败（退出码 '+code+'），后续步骤未执行');}}
export async function main(argv=process.argv.slice(2)){
 const options=parseMonthPipelineArgs(argv);if(options.help){console.log('pnpm month --month YYYYMM [--yes]：顺序执行截图、人员检测、合成；失败停止。默认月份取 TargetMonth。');return;}
 if(!options.yes)await Const.asyncConfirmIt('依次完成 '+options.month+' 月截图、人员检测和视频合成，不删除图片');
 const controller=new AbortController();let child;
 const stop=()=>{controller.abort();process.exitCode=130;if(process.platform!=='win32')child?.kill('SIGINT');};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{await executeMonthPipeline(options.month,step=>new Promise((resolve,reject)=>{
  console.log('\n▶ '+options.month+' 月：'+step.name);
  child=spawn(process.execPath,[path.join(Const.BaseDir,'src',step.script),...step.args],{cwd:Const.BaseDir,stdio:'inherit',windowsHide:true});
  child.once('error',reject);child.once('close',code=>{child=undefined;resolve(code);});
 }),controller.signal);console.log('\n✅ '+options.month+' 月全部步骤完成');}
 finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode ||= 1;});
