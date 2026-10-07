import fs from 'node:fs/promises';
import path from 'node:path';
export async function acquireTaskLock(manifestPath) {
 const lock=path.resolve(manifestPath)+'.lock';
 await fs.mkdir(path.dirname(lock),{recursive:true});
 let handle;
 try{handle=await fs.open(lock,'wx');}catch(error){if(error.code==='EEXIST')throw new Error('任务清单正在使用或上次异常中断遗留锁: '+lock+'；请不要同时运行 m1、o2 和 --tasks 检测。');throw error;}
 try{await handle.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));}catch(error){await handle.close();await fs.rm(lock,{force:true});throw error;}
 let released=false;
 return async()=>{if(released)return;released=true;await handle.close();await fs.rm(lock,{force:true});};
}
