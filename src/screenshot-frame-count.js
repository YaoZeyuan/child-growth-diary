// Container timestamps can exceed the last usable sampling boundary by a few ms.
export function screenshotFrameCount(duration, interval) {
 if(!Number.isFinite(duration)||duration<=0||!Number.isSafeInteger(interval)||interval<=0)throw new Error('截图时长和间隔无效');
 return Math.max(1,Math.ceil((duration-0.01)/interval));
}
