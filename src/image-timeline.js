import path from 'node:path';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
dayjs.extend(customParseFormat);
export function imageInfo(file) {
 const name = path.win32.basename(file.replaceAll('/', '\\'));
 const match = name.match(/^(\d{14})_(\d{14})_(\d+)_step_by_(\d+)s\.jpe?g$/i);
 if (!match) return null;
 const start=dayjs(match[1], 'YYYYMMDDHHmmss',true), index=Number(match[3]), interval=Number(match[4]);
 if(!start.isValid() || !Number.isSafeInteger(index) || !Number.isSafeInteger(interval) || interval<=0)return null;
 const time=start.add(index*interval,'second');
 return {name,stem:match[1]+'_'+match[2],index,interval,month:time.format('YYYYMM'),timeAt:time.unix(),directory:time.format('YYYY/MM/MMDD')};
}
export function calendarImagePath(root, filename) {
 const info=imageInfo(filename);
 if(!info)throw new Error('无法解析截图名: '+filename);
 return path.join(root,...info.directory.split('/'),info.name);
}
export async function* walkImages(root, io) {
 const pending=[root];
 while(pending.length){const dir=pending.pop();const handle=await io.opendir(dir,{bufferSize:1024});
 for await(const entry of handle){const uri=path.join(dir,entry.name);if(entry.isDirectory()&&!entry.name.startsWith('.'))pending.push(uri);else if(entry.isFile()&&/\.jpe?g$/i.test(entry.name))yield uri;}}
}
export function compareImageNames(a,b) {
 const left=imageInfo(a)?.name ?? path.basename(a),right=imageInfo(b)?.name ?? path.basename(b);
 return left<right?-1:left>right?1:(a<b?-1:a>b?1:0);
}
