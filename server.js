import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_PATH = path.join(DATA_DIR, 'state.json');
const PORT = Number(process.env.PORT || 5180);
const HOST = process.env.HOST || '0.0.0.0';
const HTTPS = process.env.HTTPS === '1'; // Set only if served behind real, trusted HTTPS.
const now = () => Date.now();
const uid = () => crypto.randomUUID();
const token = () => crypto.randomBytes(32).toString('base64url');
const validUsername = (str) => /^[a-z0-9_]{3,24}$/.test(str);
const normalizeUsername = (value) => String(value || '').trim().toLowerCase();
const safeStr = (value, len = 100) => typeof value === 'string' ? value.trim().slice(0, len) : '';

fs.mkdirSync(DATA_DIR, {recursive:true, mode:0o700});
let state = { users: [], alerts: [] };
if (fs.existsSync(DATA_PATH)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    if (Array.isArray(parsed.users) && Array.isArray(parsed.alerts)) state = parsed;
  } catch (e) { console.error('Database cannot be read. Refusing to overwrite.', e); process.exit(1); }
}
function save() {
  const tmp = `${DATA_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), {mode:0o600});
  fs.renameSync(tmp, DATA_PATH);
}
const sessions = new Map(); // Sessions intentionally expire on server restart.
const pairingCodes = new Map(); // childId -> {code, expires}
const events = new Map(); // userId -> Set(SSE response)
const calls = new Map(); // callId -> {childId, guardianId, status, created}
const recentLocations = new Map(); // childId -> {lat, lng, sent}
const attempts = new Map();
function rate(ip, key, max=12, windowMs=60_000) {
  const id = `${ip}:${key}`;
  const existing = attempts.get(id);
  if (!existing || existing.until < now()) { attempts.set(id, {count:1, until:now()+windowMs}); return true; }
  existing.count += 1;
  return existing.count <= max;
}
setInterval(() => {
  for (const [key, val] of attempts) if (val.until < now()) attempts.delete(key);
  for (const [sid, val] of sessions) if (val.expires < now()) sessions.delete(sid);
  for (const [id, val] of pairingCodes) if (val.expires < now()) pairingCodes.delete(id);
  for (const [id, val] of calls) if (val.created + 5*60_000 < now() && val.status === 'pending') endCall(id, 'انتهت مهلة الطلب');
}, 45_000).unref();

function send(res, status, value, headers={}) {
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(value);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers});
  res.end(payload);
}
function fail(res, code, message) {send(res, code, {error:message});}
function cookieValue(req, key) {
  const raw = req.headers.cookie || '';
  const pair = raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(`${key}=`));
  return pair ? pair.slice(key.length+1) : '';
}
function session(req) {
  const id = cookieValue(req, 'sp_session');
  const s = sessions.get(id);
  if (!s || s.expires < now()) return null;
  const user = state.users.find(u=>u.id===s.userId);
  return user ? {s, user} : null;
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Native/test clients; protected POSTs additionally require CSRF.
  const host = req.headers.host;
  try {return new URL(origin).host === host;} catch {return false;}
}
async function body(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw Object.assign(new Error('صيغة الطلب غير مدعومة'), {httpStatus:415});
  let result = '';
  for await (const chunk of req) {
    result += chunk.toString('utf8');
    if (result.length > 350_000) throw Object.assign(new Error('الطلب كبير جدًا'), {httpStatus:413});
  }
  let obj;
  try {obj=JSON.parse(result||'{}');} catch {throw Object.assign(new Error('طلب غير صالح'), {httpStatus:400});}
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw Object.assign(new Error('طلب غير صالح'), {httpStatus:400});
  return obj;
}
function setCookie(res, id, expire=false) {
  const parts = [`sp_session=${expire ? '' : id}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${expire?0:7*24*3600}`];
  if (HTTPS) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function emit(userId, name, payload={}) {
  const set = events.get(userId);
  if (!set) return;
  const msg = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...set]) {
    if (res.destroyed || res.writableEnded) {set.delete(res);continue;}
    try {res.write(msg);} catch {set.delete(res);}
  }
}
function other(user) {return state.users.find(u=>u.id===user.partnerId) || null;}
function visible(user) {
  const partner=other(user);
  const pending = [...calls.values()].find(c=>c.status==='pending'&&(c.childId===user.id||c.guardianId===user.id));
  const active = [...calls.values()].find(c=>c.status==='active'&&(c.childId===user.id||c.guardianId===user.id));
  const loc = user.role==='guardian'&&partner ? recentLocations.get(partner.id) : null;
  return {
    id:user.id, username:user.username, displayName:user.displayName, role:user.role,
    partner:partner?{displayName:partner.displayName, role:partner.role}:null,
    csrf:null,
    pendingCall:pending?{id:pending.id, status:pending.status, direction:pending.childId===user.id?'incoming':'outgoing'}:null,
    activeCall:active?{id:active.id}:null,
    location:loc&&loc.sent+30*60_000>now()?loc:null
  };
}
function notifyPair(user) {emit(user.id, 'update'); if (user.partnerId) emit(user.partnerId, 'update');}
function endCall(id, reason='تم إنهاء البث') {
  const call=calls.get(id);
  if (!call) return;
  calls.delete(id);
  emit(call.childId, 'call_end', {id, reason});
  emit(call.guardianId, 'call_end', {id, reason});
  emit(call.childId,'update'); emit(call.guardianId,'update');
}
function stopCalls(userId, reason) {
  for (const c of [...calls.values()]) if (c.childId===userId||c.guardianId===userId) endCall(c.id,reason);
}
function hashPassword(password, salt) {return crypto.scryptSync(password, salt, 64).toString('hex');}
function passwordMatches(password, user) {
  const calculated = Buffer.from(hashPassword(password, user.salt), 'hex');
  const correct = Buffer.from(user.passwordHash, 'hex');
  return calculated.length===correct.length && crypto.timingSafeEqual(calculated,correct);
}
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
function staticFile(req, res, pathname) {
  const route = pathname==='/'?'/index.html':pathname;
  const p = path.resolve(PUBLIC, `.${route}`);
  if (!p.startsWith(PUBLIC+path.sep)) return fail(res,403,'ممنوع');
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return fail(res,404,'الصفحة غير موجودة');
  res.writeHead(200,{'Content-Type':mime[path.extname(p)]||'application/octet-stream', 'Cache-Control':'no-cache'});
  fs.createReadStream(p).pipe(res);
}

const server = http.createServer(async(req,res)=>{
  // Minimal hardening, no 3rd-party trackers or cross-origin API access.
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(self), microphone=(self), geolocation=(self)');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
  if (HTTPS) res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  const pathname = new URL(req.url||'/', 'http://local').pathname;
  try {
    if (!pathname.startsWith('/api/')) {if(req.method!=='GET') return fail(res,405,'غير مسموح');return staticFile(req,res,pathname);}
    if (req.method==='POST' && !sameOrigin(req)) return fail(res,403,'المصدر غير مسموح');
    const ip=req.socket.remoteAddress || 'local';
    if (req.method==='POST' && !rate(ip,'post',80,60_000)) return fail(res,429,'طلبات كثيرة، جربي لاحقًا');
    const auth=session(req);
    if (pathname==='/api/signup' && req.method==='POST') {
      if (!rate(ip,'signup',6,10*60_000)) return fail(res,429,'محاولات كثيرة، جربي لاحقًا');
      const b=await body(req);
      const username=normalizeUsername(b.username), displayName=safeStr(b.displayName,60), password=b.password;
      if (!validUsername(username)) return fail(res,400,'اسم المستخدم: 3 إلى 24 حرف إنجليزي أو رقم أو _');
      if (displayName.length<2) return fail(res,400,'الاسم قصير جدًا');
      if (typeof password!=='string'||password.length<10||password.length>128) return fail(res,400,'كلمة المرور لازم تكون 10 أحرف على الأقل');
      if (b.role!=='child'&&b.role!=='guardian') return fail(res,400,'اختاري نوع الحساب');
      if (state.users.some(u=>u.username===username)) return fail(res,409,'اسم المستخدم موجود، اختاري اسم ثاني');
      const salt=crypto.randomBytes(16).toString('hex');
      const user={id:uid(), username, displayName, role:b.role, salt, passwordHash:hashPassword(password,salt), partnerId:null, createdAt:now()};
      state.users.push(user); save();
      const sid=token(), csrf=token();
      sessions.set(sid,{userId:user.id, csrf, expires:now()+7*86400000}); setCookie(res,sid);
      return send(res,201,{user:{...visible(user),csrf}});
    }
    if (pathname==='/api/login' && req.method==='POST') {
      if (!rate(ip,'login',10,10*60_000)) return fail(res,429,'محاولات كثيرة، جربي لاحقًا');
      const b=await body(req), username=normalizeUsername(b.username), password=b.password;
      const user=state.users.find(u=>u.username===username);
      if (!user || typeof password!=='string' || !passwordMatches(password,user)) return fail(res,401,'اسم المستخدم أو كلمة المرور غير صحيحة');
      const sid=token(),csrf=token();
      sessions.set(sid,{userId:user.id,csrf,expires:now()+7*86400000}); setCookie(res,sid);
      return send(res,200,{user:{...visible(user),csrf}});
    }
    if (pathname==='/api/health' && req.method==='GET') return send(res,200,{ok:true, name:'SafePulse X', version:'1.0.0'});
    if (!auth) return fail(res,401,'سجلي الدخول أولًا');
    const {user,s}=auth;
    if (pathname==='/api/me' && req.method==='GET') return send(res,200,{user:{...visible(user),csrf:s.csrf}});
    if (pathname==='/api/alerts' && req.method==='GET') return send(res,200,{alerts:state.alerts.filter(a=>a.from===user.id||a.partnerId===user.id).slice(-20).reverse().map(a=>({id:a.id,fromName:a.fromName,time:a.time,own:a.from===user.id}))});
    if (pathname==='/api/events' && req.method==='GET') {
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
      res.write(`event: connected\ndata: ${JSON.stringify({ok:true})}\n\n`);
      if (!events.has(user.id)) events.set(user.id,new Set());
      const stream=events.get(user.id); stream.add(res);
      const hb=setInterval(()=>{if (!res.destroyed) res.write(': ping\n\n');},20_000);
      req.on('close',()=>{clearInterval(hb);stream.delete(res);if (!stream.size) events.delete(user.id);});
      return;
    }
    if (req.method!=='POST') return fail(res,405,'غير مسموح');
    if (req.headers['x-csrf-token']!==s.csrf) return fail(res,403,'انتهت صلاحية الطلب، أعيدي تسجيل الدخول');
    const b=await body(req);
    if (pathname==='/api/logout') {
      sessions.delete(cookieValue(req,'sp_session')); setCookie(res,'',true);
      stopCalls(user.id,'تم إغلاق الحساب');
      return send(res,200,{ok:true});
    }
    if (pathname==='/api/pair/generate') {
      if (user.role!=='child') return fail(res,403,'الرمز ينشئه حساب الطفل فقط');
      if (user.partnerId) return fail(res,409,'الحساب مرتبط بالفعل');
      const code=String(crypto.randomInt(10_000_000,100_000_000));
      pairingCodes.set(user.id,{code,expires:now()+10*60_000});
      return send(res,200,{code,expires:now()+10*60_000});
    }
    if (pathname==='/api/pair/connect') {
      if (user.role!=='guardian') return fail(res,403,'حساب ولي الأمر فقط');
      if (!rate(ip,'pair',8,10*60_000)) return fail(res,429,'محاولات ربط كثيرة، جربي لاحقًا');
      if (user.partnerId) return fail(res,409,'الحساب مرتبط بالفعل');
      const code=safeStr(b.code,12), found=[...pairingCodes.entries()].find(([_,v])=>v.code===code&&v.expires>now());
      if (!found) return fail(res,404,'الرمز غير صحيح أو انتهت مدته');
      const child=state.users.find(u=>u.id===found[0]);
      if (!child || child.partnerId) return fail(res,409,'هذا الحساب مرتبط بالفعل');
      child.partnerId=user.id; user.partnerId=child.id;
      pairingCodes.delete(child.id); save();notifyPair(user);
      return send(res,200,{ok:true});
    }
    if (pathname==='/api/pair/unlink') {
      const partner=other(user);
      if (!partner) return fail(res,409,'لا يوجد حساب مرتبط');
      stopCalls(user.id,'تم إلغاء الربط');
      user.partnerId=null; partner.partnerId=null;
      pairingCodes.delete(user.id);pairingCodes.delete(partner.id);recentLocations.delete(user.id);recentLocations.delete(partner.id);
      save();emit(partner.id,'update'); emit(user.id,'update');
      return send(res,200,{ok:true});
    }
    if (pathname==='/api/call/request') {
      const child=other(user);
      if (user.role!=='guardian'||!child||child.role!=='child') return fail(res,403,'يلزم ربط حساب ولي الأمر والطفل');
      if ([...calls.values()].some(c=>(c.childId===child.id||c.guardianId===user.id))) return fail(res,409,'فيه طلب بث جاري');
      const id=uid(), call={id,childId:child.id,guardianId:user.id,status:'pending',created:now()};
      calls.set(id,call);emit(child.id,'call_request',{id, from:user.displayName});emit(user.id,'update');
      return send(res,200,{id});
    }
    if (pathname==='/api/call/accept' || pathname==='/api/call/reject') {
      const call=calls.get(safeStr(b.id,64));
      if (!call||call.childId!==user.id||call.status!=='pending') return fail(res,404,'طلب البث غير متاح');
      if (pathname.endsWith('reject')) {endCall(call.id,'تم رفض طلب البث');return send(res,200,{ok:true});}
      call.status='active';emit(call.guardianId,'call_accepted',{id:call.id});emit(call.childId,'call_accepted',{id:call.id});
      return send(res,200,{ok:true});
    }
    if (pathname==='/api/call/end') {
      const call=calls.get(safeStr(b.id,64));
      if (!call || (call.guardianId!==user.id && call.childId!==user.id)) return fail(res,404,'البث غير موجود');
      endCall(call.id,'تم إيقاف البث');return send(res,200,{ok:true});
    }
    if (pathname==='/api/call/signal') {
      const call=calls.get(safeStr(b.id,64));
      if (!call||call.status!=='active'||(call.guardianId!==user.id&&call.childId!==user.id)) return fail(res,403,'البث غير مصرح');
      const signal=b.signal;
      if (!signal || typeof signal!=='object'||!['offer','answer','candidate'].includes(signal.type)) return fail(res,400,'إشارة غير صالحة');
      const string=JSON.stringify(signal);
      if (string.length>250_000) return fail(res,413,'إشارة كبيرة جدًا');
      const recipient=call.childId===user.id?call.guardianId:call.childId;
      emit(recipient,'signal',{id:call.id,signal});
      return send(res,200,{ok:true});
    }
    if (pathname==='/api/sos') {
      const partner=other(user);
      const alert={id:uid(),from:user.id,fromName:user.displayName,partnerId:partner?.id||null,kind:'sos',time:now()};
      state.alerts.push(alert);state.alerts=state.alerts.slice(-100);save();
      if (partner) emit(partner.id,'sos',{id:alert.id,fromName:user.displayName,time:alert.time});
      emit(user.id,'update');return send(res,200,{ok:true,delivered:!!partner});
    }
    if (pathname==='/api/location/send') {
      const partner=other(user);
      if (user.role!=='child'||!partner) return fail(res,403,'الموقع يشاركه حساب الطفل المرتبط فقط');
      const lat=Number(b.lat),lng=Number(b.lng);
      if (!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180) return fail(res,400,'موقع غير صالح');
      const loc={lat:Math.round(lat*100000)/100000,lng:Math.round(lng*100000)/100000,sent:now()};
      recentLocations.set(user.id,loc);emit(partner.id,'location',loc);return send(res,200,{ok:true});
    }
    return fail(res,404,'المسار غير موجود');
  } catch(e) {
    if (!res.headersSent) fail(res,e.httpStatus||500,e.httpStatus?e.message:'صار خطأ غير متوقع');
    else {try {res.end();} catch{}}
    if (!e.httpStatus) console.error('Request error',e);
  }
});
server.listen(PORT,HOST,()=>console.log(`\nSafePulse X ready at http://${HOST}:${PORT}\nNo Supabase or external packages required.\n`));
export {server};
