// Capacity includes images being prepared and waiting for inference.
export function createPreparedQueue(items, workers, inputSize, capacity, signal) {
 let next=0,used=0,active=workers.length,fatal;
 const ready=[],waiters=[];
 const wake=()=>{for(const resolve of waiters.splice(0))resolve();};
 const wait=()=>new Promise(resolve=>waiters.push(resolve));
 const stats=workers.map((worker,i)=>({id:'preprocess-worker-'+(i+1),pid:worker.pid,processed:0,workingSeconds:0}));
 const producers=workers.map(async(worker,i)=>{
  try{
   while(!signal?.aborted&&!fatal){
    while(used>=capacity&&!signal?.aborted&&!fatal)await wait();
    if(signal?.aborted||fatal||next>=items.length)break;
    const item=items[next++];used++;const start=performance.now();
    try{const prepared=await worker.prepare(item.file,inputSize);ready.push({...item,prepared});}
    catch(error){if(error.workerExited){used--;throw error;}ready.push({...item,error});}
    stats[i].processed++;stats[i].workingSeconds+=(performance.now()-start)/1000;wake();
   }
  }catch(error){fatal=error;wake();}finally{active--;wake();}
 });
 const abort=()=>wake();signal?.addEventListener('abort',abort);
 return {
  stats,
  async take(){
   while(true){
    if(fatal)throw fatal;
    if(signal?.aborted)return;
    if(ready.length){const item=ready.shift();used--;wake();return item;}
    if(!active)return;
    await wait();
   }
  },
  async close(){fatal??=new Error('预处理队列已关闭');wake();await Promise.all(producers);signal?.removeEventListener('abort',abort);ready.length=0;},
 };
}
