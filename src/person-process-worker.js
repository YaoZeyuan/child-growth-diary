import fs from 'node:fs/promises';
let detector;
// Let the master stop dispatching and drain the current image before closing.
process.on('SIGINT',()=>{});
process.on('SIGTERM',()=>{});
const send=message=>new Promise((resolve,reject)=>process.send(message,error=>error?reject(error):resolve()));
process.on('disconnect',()=>process.exit(0));
process.on('message',async message=>{
 try {
  if(message.type==='init'){
   if(message.role==='preprocess'){await send({type:'ready',provider:'cpu-preprocess',pid:process.pid});return;}
   const {createPersonDetector}=await import(message.detectorModule??'./person-detector.js');
   detector=await createPersonDetector(message.options);
   await send({type:'ready',provider:detector.provider,modelSha256:detector.modelSha256,inputSize:detector.inputSize,pid:process.pid});
  }else if(message.type==='prepare'){
   const {prepareImage}=await import('./person-detector.js');const start=performance.now();const tensor=await prepareImage(message.file,message.inputSize);
   try{await send({type:'result',result:{pixels:Buffer.from(tensor.data.buffer,tensor.data.byteOffset,tensor.data.byteLength),preprocessMs:performance.now()-start}});}finally{tensor.dispose();}
  }else if(message.type==='infer'){
   await send({type:'result',result:await detector.inferPrepared(message.pixels)});
  }else if(message.type==='detect'){
   const stat=await fs.stat(message.file);if(!stat.isFile()||stat.size<=0)throw new Error('图片无效');
   const result=detector.inspect?await detector.inspect(message.file):{hasPerson:await detector.detect(message.file)};
   await send({type:'result',result});
  }else if(message.type==='close'){
   await detector?.close();await send({type:'closed'});process.disconnect();
  }
 }catch(error){await send({type:'error',error:error.message}).catch(()=>{});}
});
