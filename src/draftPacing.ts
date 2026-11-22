import {setTimeout as delay} from 'node:timers/promises';

const clock = {
  now:()=>performance.now(),
  wait:(ms:number,signal:AbortSignal):Promise<void>=>delay(ms,undefined,{signal}),
};

/** Keep the receipt pending until its review window has elapsed or the native run ends. */
export async function waitForDraftInterval(start:number, intervalMs:number, active:()=>boolean,
  signal:AbortSignal, onWait?: (ms:number)=>void, timer=clock): Promise<boolean> {
  const end=start+intervalMs;
  let announced=false;
  while(!signal.aborted && active()){
    const remaining=end-timer.now();
    if(remaining<=0)return true;
    if(!announced){onWait?.(remaining);announced=true;}
    try {await timer.wait(Math.min(remaining,250),signal);}
    catch(error){if(signal.aborted)return false;throw error;}
  }
  return false;
}
