#!/usr/bin/env bash
# Works shop reminders: READ-ONLY evidence for one day (Asia/Jerusalem).
# Deploys nothing and writes nothing to Firebase. Push tokens never leave this
# script: they are reduced to sha256[:10] and the raw export is overwritten.
# Output: ~/works-evidence-DAY/report.txt (safe to share) plus the raw logs.
#
# Usage in an authenticated Cloud Shell, from a clone of the repository:
#   bash scripts/collect-shop-evidence.sh 2026-09-28
set -euo pipefail
DAY="${1:-$(TZ=Asia/Jerusalem date +%F)}"; P=mini-market-shalom
[[ "$DAY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "usage: $0 YYYY-MM-DD" >&2; exit 2; }
S=$(date -u -d "TZ=\"Asia/Jerusalem\" $DAY 00:00" +%FT%TZ)
# Receipts are uploaded by the phone up to ~15 minutes after the reminder.
E=$(date -u -d "TZ=\"Asia/Jerusalem\" $DAY 23:59:59 + 1 hour" +%FT%TZ)
OUT=~/works-evidence-$DAY; mkdir -p "$OUT"; cd "$OUT"
FB(){ ${FB_GET:-npx --yes --package=firebase-tools@15.31.0 firebase database:get} "$@" --project "$P"; }

{
echo "== functions"
for f in "sendShopShiftReminders us-central1" "setShopNotificationDevice europe-west1" "clockReminders europe-west1"; do
  set -- $f
  echo -n "$1: "; gcloud functions describe "$1" --gen2 --region="$2" --project="$P" \
    --format='value(state,updateTime,serviceConfig.timeoutSeconds,serviceConfig.maxInstanceCount)' 2>/dev/null || echo "not found"
done
echo -n "scheduler: "; gcloud scheduler jobs describe firebase-schedule-sendShopShiftReminders-us-central1 --location=us-central1 --project="$P" \
  --format='value(state,schedule,timeZone,lastAttemptTime,status.code)' 2>/dev/null || echo "not found"
} > config.txt

logs(){ gcloud logging read --project="$P" --order=asc --limit=30000 --format=json \
  "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$1\" AND timestamp>=\"$S\" AND timestamp<=\"$E\" AND $2"; }
logs sendshopshiftreminders 'NOT logName:"run.googleapis.com%2Frequests"' > scheduler.json
logs sendshopshiftreminders 'logName:"run.googleapis.com%2Frequests"' > scheduler-requests.json
logs setshopnotificationdevice 'NOT logName:"run.googleapis.com%2Frequests"' > device.json
logs setshopnotificationdevice 'logName:"run.googleapis.com%2Frequests"' > device-requests.json

FB /config/managerUid > mgr.json
FB /shopNotificationDevices > devices.raw.json
FB /shopNotificationRouting > routing.json
FB "/shopReminderDeliveries/$DAY" > deliveries.json
FB "/shopReminderSnoozes/$DAY" > snoozes.json
FB "/shopReminderCancellations/$DAY" > cancellations.json
FB /employees > employees.raw.json
FB /oneTimeShifts > onetime.json
FB /recurringShifts > recurring.json
# Attendance since the day before only: push ids start with their creation time.
KEY=$(python3 - "$DAY" <<'PY'
import sys,datetime,zoneinfo
C="-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz"
t=int((datetime.datetime.fromisoformat(sys.argv[1]).replace(tzinfo=zoneinfo.ZoneInfo("Asia/Jerusalem"))-datetime.timedelta(days=1)).timestamp()*1000)
s=""
for _ in range(8): s=C[t%64]+s; t//=64
print(s)
PY
)
FB /shifts --order-by-key --start-at "$KEY" > shifts.recent.json

python3 - "$DAY" > report.txt <<'PY'
import json,sys,hashlib,datetime,zoneinfo,re,collections
DAY=sys.argv[1]; IL=zoneinfo.ZoneInfo("Asia/Jerusalem")
def L(f):
  try: v=json.load(open(f))
  except Exception: return {}
  return v if v is not None else {}
t=lambda ms:datetime.datetime.fromtimestamp(ms/1000,IL).strftime("%H:%M:%S") if ms else "-"
sha=lambda s:hashlib.sha256(s.encode()).hexdigest()
js=lambda v:json.dumps(v,ensure_ascii=False,separators=(",",":"))
mgr=L("mgr.json"); devs=L("devices.raw.json"); emps=L("employees.raw.json")
name=lambda e:(emps.get(e) or {}).get("name") or ("…"+str(e)[-6:])
print("Works shop reminders — evidence for",DAY,"(Asia/Jerusalem)\n")
print(open("config.txt").read())
print("== devices (token only as sha256[:10])")
for k,d in devs.items():
  d=d or {}
  print(" ",k[:8],"enabled=%s"%d.get("enabled"),"manager=%s"%(d.get("uid")==mgr),
        "token=%s"%(sha(d["token"])[:10] if d.get("token") else "NONE"),"updatedAt="+t(d.get("updatedAt")),
        ("disabled=%s at %s"%(d.get("disabledReason"),t(d.get("disabledAt"))) if d.get("disabledReason") else ""))
print("  routing:",L("routing.json"))
def nt(v):
  m=re.match(r"^(\d{1,2}):(\d{2})$",str(v or ""))
  return None if not m or int(m[1])>23 or int(m[2])>59 else "%02d:%s"%(int(m[1]),m[2])
dow=(datetime.date.fromisoformat(DAY).weekday()+1)%7
plans={}
for s in L("recurring.json").values():
  s=s or {}; v=s.get("daysOfWeek"); v=v if isinstance(v,list) else list((v or {}).values())
  if dow in [int(x) for x in v if str(x).isdigit()] and not (s.get("cancelledDates") or {}).get(DAY): plans[(s.get("employeeId"),nt(s.get("startTime")),nt(s.get("endTime")))]=1
for s in L("onetime.json").values():
  if s and s.get("date")==DAY: plans[(s.get("employeeId"),nt(s.get("startTime")),nt(s.get("endTime")))]=1
label={}
for (e,a,b) in plans:
  if not e or not a or not b or a==b: continue
  pk=js([e,DAY,a,b]); label[sha(pk)]="%s %s-%s"%(name(e),a,b)
  for kind in ("in","out"):
    ek=js([pk,kind]); label[sha(js([ek,[]]))]="%s %s-%s %s"%(name(e),a,b,kind)
    for dev in devs: label[sha(ek+dev)]="%s %s-%s %-3s dev %s"%(name(e),a,b,kind,dev[:8])
print("\n== planned shifts:"," | ".join(sorted(label[sha(js([e,DAY,a,b]))] for (e,a,b) in plans if e and a and b and a!=b)) or "none")
print("\n== delivery rows (last attempt/send per reminder)")
for h,r in sorted(L("deliveries.json").items(),key=lambda x:(x[1] or {}).get("lastAttemptAt",0)):
  r=r or {}; print(" ",label.get(h,"?"+h[:8]),"lastAttempt="+t(r.get("lastAttemptAt")),"lastSent="+t(r.get("lastSentAt")),
    "failed=%s"%r.get("failedAttempts",0),"unreleased=%s"%bool(r.get("claimId")))
print("\n== snoozes"); [print(" ",label.get(h,"exit snooze "+h[:8]),"until="+t((r or {}).get("until")),"set="+t((r or {}).get("updatedAt"))) for h,r in L("snoozes.json").items()]
print("== 'not coming' cancellations"); [print(" ",label.get(h,"?"+h[:8]),"at="+t((r or {}).get("updatedAt"))) for h,r in L("cancellations.json").items()]
print("\n== attendance since the day before")
for k,s in sorted(L("shifts.recent.json").items(),key=lambda x:(x[1] or {}).get("clockIn") or 0):
  if isinstance(s,dict):
    print(" ",name(s.get("employeeId")),datetime.datetime.fromtimestamp((s.get("clockIn") or 0)/1000,IL).strftime("%m-%d %H:%M"),"->",
          t(s.get("clockOut")) if s.get("clockOut") else "OPEN","(auto-closed)" if s.get("autoCloseFlag") else "")
lt=lambda e:datetime.datetime.fromisoformat(e["timestamp"].replace("Z","+00:00")).astimezone(IL)
sched=L("scheduler.json") or []; dev=L("device.json") or []
receipts={}
for e in dev:
  j=e.get("jsonPayload") or {}
  if j.get("message")=="Shop reminder receipt": receipts.setdefault((j.get("ref"),int(j.get("sentAt") or 0)),[]).append(j)
print("\n== reminders sent by the server and what the phone reported")
print("   (a missing receipt: the phone never received it, or has not uploaded yet)")
checked=set(); counts=collections.Counter()
for e in sched:
  j=e.get("jsonPayload") or {}; m=j.get("message") or e.get("textPayload") or ""; at=lt(e).strftime("%H:%M:%S")
  if m=="Shop reminders checked": checked.add(lt(e).strftime("%H:%M")); counts["ticks"]+=1
  elif m=="Shop reminder sent":
    r=receipts.get((j.get("ref"),int(j.get("sentAt") or 0)),[])
    got=", ".join("%s via %s after %.0fs"%(x.get("outcome"),x.get("path"),(int(x.get("receivedAt") or 0)-int(j.get("sentAt") or 0))/1000) for x in r) or "NO RECEIPT"
    print(" ",at,"SENT   %-10s %-3s plan %s  -> %s"%(name(j.get("employeeId")),j.get("kind"),j.get("start"),got)); counts["sent"]+=1
  elif m=="Shop reminder skipped": print(" ",at,"SKIP   %-10s %-3s plan %s  reason=%s"%(name(j.get("employeeId")),j.get("kind"),j.get("start"),j.get("reason")))
  elif m=="Shop reminder send failed": print(" ",at,"FAILED %-10s %-3s plan %s  code=%s"%(name(j.get("employeeId")),j.get("kind"),j.get("start"),j.get("code"))); counts["failed"]+=1
  elif e.get("severity") in ("WARNING","ERROR","CRITICAL","ALERT","EMERGENCY") or re.search("timeout|memory|exceeded",m,re.I):
    print(" ",at,e.get("severity"),m[:160])
print("\n== phone receipts by outcome:",dict(collections.Counter(x.get("outcome") for v in receipts.values() for x in v)) or "none uploaded")
for e in dev:
  j=e.get("jsonPayload") or {}; m=j.get("message") or e.get("textPayload") or ""
  if m=="Shop test send failed" or e.get("severity") in ("ERROR","CRITICAL"): print("  device fn:",lt(e).strftime("%H:%M:%S"),e.get("severity"),m[:120],j.get("code",""))
def statuses(f):
  st=collections.Counter(); bad=[]
  for e in L(f) or []:
    h=e.get("httpRequest") or {}; st[h.get("status")]+=1
    lat=float(str(h.get("latency","0s")).rstrip("s") or 0)
    if h.get("status")!=200 or lat>20: bad.append("%s %s %.1fs"%(lt(e).strftime("%H:%M:%S"),h.get("status"),lat))
  return st,bad
st,bad=statuses("scheduler-requests.json")
print("\n== scheduler runs by HTTP status:",dict(st),"| 'checked' lines:",counts["ticks"])
for x in bad[:60]: print("  ",x)
reqmin={lt(e).strftime("%H:%M") for e in L("scheduler-requests.json") or [] if lt(e).strftime("%F")==DAY}
print("minutes without a scheduler run:",[m for m in ("%02d:%02d"%(h,i) for h in range(24) for i in range(60)) if m not in reqmin][:60])
st,bad=statuses("device-requests.json")
print("\n== phone -> server calls by HTTP status:",dict(st))
for x in bad[:40]: print("  ",x)
PY
echo '{}' > devices.raw.json
echo "Report: $OUT/report.txt"
cat "$OUT/report.txt"
