import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export async function createPersonProcessDetector(options={}, {detectorModule,role='inference'}={}) {
 const child=fork(fileURLToPath(new URL('./person-process-worker.js',import.meta.url)),[],{stdio:['ignore','inherit','inherit','ipc'],execArgv:[],serialization:'advanced'});
 let pending,ended=false,closing=false;
 const exited=new Promise(resolve=>child.once('exit',resolve));
 const fail=error=>{error.workerExited=true;ended=true;if(pending){pending.reject(error);pending=undefined;}};
 child.on('error',fail);
 child.on('exit',(code,signal)=>fail(new Error('检测子进程退出: PID '+child.pid+', code='+code+', signal='+signal)));
 child.on('message',message=>{if(!pending)return;const request=pending;pending=undefined;if(message.type==='error')request.reject(new Error(message.error));else request.resolve(message);});
 const request=message=>new Promise((resolve,reject)=>{
  if(ended)return reject(Object.assign(new Error('检测子进程已退出'),{workerExited:true}));
  if(pending)return reject(new Error('检测子进程正在处理任务'));
  pending={resolve,reject};child.send(message,error=>{if(error&&pending){pending.reject(error);pending=undefined;}});
 });
 let ready;
 try{ready=await request({type:'init',options,detectorModule,role});}catch(error){child.kill('SIGKILL');await exited;throw error;}
 return {
  provider:ready.provider,modelSha256:ready.modelSha256,pid:ready.pid,inputSize:ready.inputSize,
  async prepare(file,inputSize){return (await request({type:'prepare',file,inputSize})).result;},
  async inferPrepared(pixels){return (await request({type:'infer',pixels})).result;},
  async inspect(file){return (await request({type:'detect',file})).result;},
  async detect(file){return (await this.inspect(file)).hasPerson;},
  async close(){
   if(ended)return;if(closing)return exited;closing=true;
   const timer=setTimeout(()=>child.kill('SIGKILL'),10000);timer.unref();
   try{await request({type:'close'});await exited;}finally{clearTimeout(timer);if(!ended)child.kill('SIGKILL');}
  },
 };
}
