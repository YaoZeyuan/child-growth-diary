import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {OutputImgDir} from './const/index.js';

export async function flattenVideoImages(root=OutputImgDir,month='202607',{dryRun=false}={}) {
 if(!/^\d{4}(0[1-9]|1[0-2])$/.test(month))throw new Error('月份须为 YYYYMM');
 root=path.resolve(root);
 const folderPattern=new RegExp('^'+month+'\\d{8}_\\d{14}_step_by_[1-9]\\d*s$');
 const stats={folders:0,moved:0,skipped:0,deleted:0,retained:0};
 for(const entry of await fs.readdir(root,{withFileTypes:true})){
  if(!entry.isDirectory()||!folderPattern.test(entry.name))continue;
  stats.folders++;const source=path.join(root,entry.name);
  for(const image of await fs.readdir(source,{withFileTypes:true})){
   if(!image.isFile()||!/\.(jpe?g|png|webp)$/i.test(image.name))continue;
   const from=path.join(source,image.name),to=path.join(root,image.name);
   if(dryRun){try{await fs.lstat(to);stats.skipped++;}catch(error){if(error.code!=='ENOENT')throw error;stats.moved++;}continue;}
   // Exclusive hard-link creation on the same volume: never overwrites a target.
   try{try{await fs.link(from,to);}catch(error){if(!['EPERM','ENOTSUP','EXDEV'].includes(error.code))throw error;await fs.copyFile(from,to,fs.constants.COPYFILE_EXCL);}}catch(error){if(error.code==='EEXIST'){stats.skipped++;console.log('目标已存在，保留原图: '+from);continue;}throw error;}
   await fs.unlink(from);stats.moved++;
  }
  if(!dryRun){
   try{await fs.rmdir(source);stats.deleted++;}
   catch(error){if(error.code!=='ENOTEMPTY'&&error.code!=='EEXIST')throw error;stats.retained++;console.log('目录仍有文件，保留: '+source);}
  }
 }
 console.log((dryRun?'预览（未修改文件）: ':'完成: ')+JSON.stringify(stats));return stats;
}

async function main(argv){
 let month='202607',dryRun=false;
 for(let i=0;i<argv.length;i++){if(argv[i]==='--')continue;if(argv[i]==='--month')month=argv[++i];else if(argv[i]==='--dry-run')dryRun=true;else throw new Error('用法: pnpm flatten-images [--month 202607] [--dry-run]');}
 await flattenVideoImages(OutputImgDir,month,{dryRun});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
