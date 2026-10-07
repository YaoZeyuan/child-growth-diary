import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export function choosePersonDevice(adapters) {
 const nvidia=adapters.find(adapter=>adapter.vendorId===0x10de);
 return nvidia ?? adapters.find(adapter=>adapter.deviceId===0) ?? {deviceId:0,name:'默认设备',vendorId:0};
}
export function preferredPersonDevice() {
 try {
  const raw=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./list-dxgi-adapters.ps1',import.meta.url))],{encoding:'utf8',windowsHide:true,timeout:15000});
  const adapters=JSON.parse(raw.replace(/^\uFEFF/,''));
  if(!Array.isArray(adapters)||adapters.some(adapter=>!Number.isSafeInteger(adapter.deviceId)||adapter.deviceId<0||!Number.isInteger(adapter.vendorId)))throw Error('显卡列表格式无效');
  return choosePersonDevice(adapters);
 }catch(error){console.error('显卡枚举失败，使用 DirectML 0 号设备: '+error.message);return {deviceId:0,name:'默认设备',vendorId:0};}
}
