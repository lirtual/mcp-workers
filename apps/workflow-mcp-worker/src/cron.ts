/** A deliberately small, explicit subset of five-field UTC Cron.
 * No names, Quartz extensions, timezone/DST interpretation or catch-up.
 * Reject unsupported syntax at Draft validation rather than guessing.
 */
const BOUNDS = [[0,59],[0,23],[1,31],[1,12],[0,7]] as const;
export type CronTrigger = { type:'cron'; schedule:string };

type CronField = {wildcard:boolean; values:Set<number>};
function parseField(source:string,min:number,max:number):CronField {
  if(!source||source.length>80)throw Error('invalid_cron_schedule');
  const values=new Set<number>();
  const parts=source.split(',');
  if(parts.length>16)throw Error('invalid_cron_schedule');
  for(const part of parts){
    const fields=part.split('/');
    if(fields.length>2||!fields[0])throw Error('invalid_cron_schedule');
    const [base,stepSource]=fields;
    if(stepSource!==undefined && (!/^[1-9][0-9]*$/.test(stepSource)||Number(stepSource)>max-min+1))
      throw Error('invalid_cron_schedule');
    const step=stepSource===undefined?1:Number(stepSource);
    let start:number,end:number;
    if(base==='*'){start=min;end=max;}
    else if(/^\d+$/.test(base)){start=Number(base);end=start;if(stepSource!==undefined)throw Error('invalid_cron_schedule');}
    else {
      const range=/^(\d+)-(\d+)$/.exec(base);
      if(!range)throw Error('invalid_cron_schedule');
      start=Number(range[1]);end=Number(range[2]);
    }
    if(start<min||end>max||start>end)throw Error('invalid_cron_schedule');
    for(let number=start;number<=end;number+=step)values.add(number);
  }
  // Both 0 and 7 represent Sunday.
  if(max===7 && values.has(7))values.add(0);
  return {wildcard:source==='*',values};
}
export function parseUtcCron(schedule:unknown):readonly CronField[]{
  if(typeof schedule!=='string'||schedule.length>160||schedule.trim()!==schedule)
    throw Error('invalid_cron_schedule');
  const parts=schedule.split(/\s+/);
  if(parts.length!==5)throw Error('invalid_cron_schedule');
  return parts.map((part,i)=>parseField(part,BOUNDS[i][0],BOUNDS[i][1]));
}
export function cronMatchesUtc(schedule:string,scheduledTime:number):boolean {
  if(!Number.isSafeInteger(scheduledTime)||scheduledTime<0)throw Error('invalid_scheduled_time');
  const fields=parseUtcCron(schedule);
  const date=new Date(Math.floor(scheduledTime/60000)*60000);
  if(!Number.isFinite(date.getTime()))throw Error('invalid_scheduled_time');
  const [minute,hour,day,month,weekday]=fields;
  if(!minute.values.has(date.getUTCMinutes()) || !hour.values.has(date.getUTCHours()) ||
     !month.values.has(date.getUTCMonth()+1))return false;
  const dom=day.values.has(date.getUTCDate()), dow=weekday.values.has(date.getUTCDay());
  // Conventional Cron semantics: when both day fields are restricted, either matches.
  return day.wildcard ? dow : weekday.wildcard ? dom : dom||dow;
}
