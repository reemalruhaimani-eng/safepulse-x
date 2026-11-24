const $ = (id) => document.getElementById(id);
const ui = {
  guest: $('guestView'), dash: $('dashboardView'), authForm:$('authForm'),
  authError:$('authError'), toast:$('toast'), online:$('onlinePill'),
  incoming:$('incomingLive'), localWrap:$('localWrap'), remoteWrap:$('remoteWrap')
};
let me=null,csrf='',mode='login',streamEvents=null,pc=null,localStream=null,callId=null,remoteCandidateQueue=[],lang='ar',toastTimer=null;
const translation = {
  ar: {},
  en: {
    protected:'Private space',logout:'Log out', welcomeTag:'Safety begins with consent',heroTitle:'Stay close. Stay safe.',
    heroDescription:'Family safety, built around consent. Link devices with a temporary code, share location when you choose, and start live video/audio only with clear approval.',
    feature1:'Private accounts',feature2:'Temporary pairing code',feature3:'Consensual live video', login:'Log in',signup:'Create account',
    loginTitle:'Welcome back 👋',signupTitle:'Make your own account',loginSubtitle:'Log in without email confirmation.',signupSubtitle:'No emails or confirmation codes needed.',
    name:'Display name', username:'Username',usernameHint:'English letters, numbers or _ — no @',password:'Password', accountType:'Account type',child:'Child or teen',guardian:'Parent or guardian',
    privacyNote:'Your account is stored on this app server, without Supabase.',dashboardTag:'Safety dashboard',hello:'Hello',dashboardSubtitle:'Family connection, always with consent.',
    pairTitle:'Family pairing',pairSubtitle:'One-time code',childPairInfo:'Show your code only to your trusted guardian.',generate:'Generate pairing code',
    guardianPairInfo:'Enter the code shown on the child device with their permission.',pairCodeLabel:'8-digit pairing code',connect:'Link accounts',
    connected:'Connected securely',canUnlink:'Either person can unlink at any time.',unlink:'Unlink',
    emergency:'Emergency assistance',emergencySubtitle:'Real emergencies only',sendSOS:'Send SOS alert to family',
    sosDisclaimer:'Alerts the linked partner in this app when online. Does not contact police.',police:'Call emergency 112',callDisclaimer:'Opens the phone dialer. No automatic calls.',
    live:'Live camera & microphone',liveSubtitle:'Only with visible permission, no recording',guardianLiveInfo:'Request a live feed. The other person must approve it on their own device.',
    requestLive:'Request live video',waiting:'Waiting for approval…',cancel:'Cancel',soundHint:'If audio is muted, press Play in the video.',endLive:'Stop live feed',
    childLiveInfo:'Nobody can activate your camera or microphone without you choosing to allow it.',incomingExplain:'Your browser will ask for camera and microphone permission after you accept.',
    accept:'Approve & start live',reject:'Decline',liveWarning:'Your camera and microphone are ON. You can stop them now.',mediaSafety:'No hidden background capture or recording.',
    location:'Location',locationSubtitle:'One-time sharing with permission',locationInfo:'Share your current location one time, only when you choose.',
    shareLocation:'Share my location once',noLocation:'No shared location right now.',openMap:'Open on map',locationDisclaimer:'No automatic or constant location tracking.',
    activity:'Recent alerts',activitySubtitle:'Recent family SOS events',noAlerts:'No alerts yet.', official:'Official emergency numbers'
  }
};
const arText=new Map([...document.querySelectorAll('[data-i18n]')].map(n=>[n,n.textContent]));
function translate() {
  document.documentElement.lang=lang;
  document.documentElement.dir=lang==='ar'?'rtl':'ltr';
  for (const [el,original] of arText) el.textContent=lang==='ar'?original:translation.en[el.dataset.i18n]||original;
  $('langBtn').textContent=lang==='ar'?'EN':'عربي';
  if (!me) setAuthMode(mode); else renderRole();
}
$('langBtn').addEventListener('click',()=>{lang=lang==='ar'?'en':'ar';translate();});
function notice(msg) {clearTimeout(toastTimer);ui.toast.textContent=msg;ui.toast.classList.add('show');toastTimer=setTimeout(()=>ui.toast.classList.remove('show'),5000);}
async function api(url, options={}) {
  const headers={'Accept':'application/json'};
  if (options.method==='POST') {headers['Content-Type']='application/json';if(csrf) headers['X-CSRF-Token']=csrf;}
  const response=await fetch(url,{method:options.method||'GET',headers,body:options.body?JSON.stringify(options.body):undefined,credentials:'same-origin',cache:'no-store'});
  const result=await response.json().catch(()=>({error:'تعذر قراءة الرد من السيرفر'}));
  if(!response.ok) throw new Error(result.error||`HTTP ${response.status}`);
  return result;
}
function setAuthMode(next) {
  mode=next;
  $('loginTab').classList.toggle('active',next==='login');$('signupTab').classList.toggle('active',next==='signup');
  $('loginTab').setAttribute('aria-selected',String(next==='login'));$('signupTab').setAttribute('aria-selected',String(next==='signup'));
  $('displayNameWrap').hidden=next!=='signup';$('roleWrap').hidden=next!=='signup';$('displayName').required=next==='signup';
  $('password').autocomplete=next==='signup'?'new-password':'current-password';
  $('authTitle').textContent=lang==='ar'?(next==='login'?'ياهلا برجعتج 👋':'سوي حسابج بخطوة واحدة 💜'):(next==='login'?translation.en.loginTitle:translation.en.signupTitle);
  $('authSubtitle').textContent=lang==='ar'?(next==='login'?'ادخلي بحسابج من غير إيميل ولا رسائل تأكيد.':'لا إيميل ولا رسائل تأكيد. اختاري اسم مستخدم وكلمة مرور.'):(next==='login'?translation.en.loginSubtitle:translation.en.signupSubtitle);
  $('authSubmit').textContent=lang==='ar'?(next==='login'?'تسجيل الدخول':'إنشاء الحساب'):(next==='login'?translation.en.login:translation.en.signup);
  ui.authError.hidden=true;
}
$('loginTab').addEventListener('click',()=>setAuthMode('login'));
$('signupTab').addEventListener('click',()=>setAuthMode('signup'));
ui.authForm.addEventListener('submit',async(e)=>{
  e.preventDefault();ui.authError.hidden=true;
  const btn=$('authSubmit');btn.disabled=true;
  try {
    const b={username:$('username').value,password:$('password').value};
    if(mode==='signup') {b.displayName=$('displayName').value;b.role=document.querySelector('input[name="role"]:checked').value;}
    const data=await api(mode==='login'?'/api/login':'/api/signup',{method:'POST',body:b});
    me=data.user;csrf=me.csrf;await render();connectEvents();
    notice(lang==='ar'?'أهلًا! دخلتي الحساب بنجاح 💗':'You are signed in!');
    ui.authForm.reset();
  } catch(err) {ui.authError.textContent=err.message;ui.authError.hidden=false;}
  finally {btn.disabled=false;}
});
function renderRole(){
  if(!me) return;
  $('roleBadge').textContent=me.role==='child'?(lang==='ar'?'🌱 حساب الطفل أو المراهق':'🌱 Child/teen account'):(lang==='ar'?'💜 حساب ولي الأمر':'💜 Guardian account');
}
async function render() {
  const loggedIn=Boolean(me);
  ui.guest.hidden=loggedIn;ui.dash.hidden=!loggedIn;$('logoutBtn').hidden=!loggedIn;ui.online.hidden=!loggedIn;
  if (!loggedIn) return;
  $('helloName').textContent=me.displayName;renderRole();
  const paired=Boolean(me.partner);
  $('unpaired').hidden=paired;$('paired').hidden=!paired;
  $('childPair').hidden=me.role!=='child';$('guardianPair').hidden=me.role!=='guardian';
  $('guardianLive').hidden=me.role!=='guardian';$('childLive').hidden=me.role!=='child';
  $('childLocation').hidden=me.role!=='child';$('guardianLocation').hidden=me.role!=='guardian';
  if(paired) $('partnerName').textContent=me.partner.displayName;
  $('requestLive').disabled=!paired;
  $('shareLocation').disabled=!paired;
  $('sosBtn').disabled=!paired;
  if(!paired) {$('codeBox').hidden=true;await cleanCall(false);}
  const pending=me.pendingCall;
  $('requestPending').hidden=!(pending?.direction==='outgoing');
  ui.incoming.hidden=!(pending?.direction==='incoming');
  if(pending?.direction==='incoming') {callId=pending.id;$('incomingText').textContent=lang==='ar'?'ولي الأمر يطلب بث بالكاميرا والمايك. توافقين؟':'Your linked guardian requests live camera and microphone. Allow?';}
  if(pending?.direction==='outgoing') callId=pending.id;
  if(!me.activeCall && !me.pendingCall && !localStream && !pc) callId=null;
  if(me.role==='guardian') renderLocation();
  await loadAlerts();
}
async function refresh() {
  try {const data=await api('/api/me');me=data.user;csrf=me.csrf;await render();}
  catch {await cleanCall(false);me=null;csrf='';streamEvents?.close();streamEvents=null;await render();}
}
async function loadAlerts(){
  try{
    const list=(await api('/api/alerts')).alerts;
    const root=$('alertsList');root.replaceChildren();
    if(!list.length){const li=document.createElement('li');li.textContent=lang==='ar'?'ما في تنبيهات للحين.':'No alerts yet.';root.append(li);return;}
    for(const a of list) {
      const li=document.createElement('li');
      const label=lang==='ar'?`${a.own?'إنتِ':a.fromName} • تنبيه SOS`:`${a.own?'You':a.fromName} • SOS alert`;
      li.textContent=`🆘 ${label}  ·  ${new Date(a.time).toLocaleString(lang==='ar'?'ar-KW':'en-GB')}`;root.append(li);
    }
  }catch(e){console.error('Alerts read failed',e);}
}
function connectEvents() {
  streamEvents?.close(); if(!me)return;
  streamEvents=new EventSource('/api/events');
  streamEvents.addEventListener('update',refresh);
  streamEvents.addEventListener('call_request',async(e)=>{let d=JSON.parse(e.data);callId=d.id;notice(lang==='ar'?'وصلك طلب بث مباشر!':'You have a live video request');await refresh();});
  streamEvents.addEventListener('call_accepted',async(e)=>{
    const d=JSON.parse(e.data);callId=d.id;
    if(me?.role==='guardian') {createPeer();ui.remoteWrap.hidden=false;$('requestPending').hidden=true;notice(lang==='ar'?'الطرف الثاني وافق. جاري الاتصال…':'Approved. Connecting…');}
  });
  streamEvents.addEventListener('call_end',async(e)=>{const d=JSON.parse(e.data);await cleanCall(false);notice(d.reason||'تم إنهاء البث');await refresh();});
  streamEvents.addEventListener('signal',async(e)=>{const d=JSON.parse(e.data);await onSignal(d);});
  streamEvents.addEventListener('sos',async(e)=>{
    const d=JSON.parse(e.data);notice(`🆘 SOS — ${d.fromName}`);
    if('vibrate' in navigator) navigator.vibrate([250,150,250]);
    await loadAlerts();
  });
  streamEvents.addEventListener('location',async(e)=>{const d=JSON.parse(e.data);if(me){me.location=d;renderLocation();notice('📍 تم استقبال موقع مشارك');}});
  streamEvents.onerror=()=>{console.warn('Event stream reconnecting');};
}
$('logoutBtn').addEventListener('click',async()=>{
  await cleanCall(true);
  try{await api('/api/logout',{method:'POST',body:{}});}catch{}
  streamEvents?.close();streamEvents=null;me=null;csrf='';await render();notice('تم تسجيل الخروج');
});
$('generateCode').addEventListener('click',async()=>{
  try{const d=await api('/api/pair/generate',{method:'POST',body:{}});$('pairCode').textContent=d.code;$('codeBox').hidden=false;$('codeExpiry').textContent=lang==='ar'?'ينتهي بعد 10 دقايق — شاركيه مع ولي أمرج فقط':'Expires in 10 minutes — only share with your guardian';}
  catch(e){notice(e.message);}
});
$('guardianPair').addEventListener('submit',async(e)=>{e.preventDefault();try{await api('/api/pair/connect',{method:'POST',body:{code:$('pairCodeInput').value}});notice('تم ربط الحسابين 💗');await refresh();}catch(e){notice(e.message);}});
$('unlinkBtn').addEventListener('click',async()=>{if(!confirm(lang==='ar'?'متأكدة تبين تلغين الربط؟':'Are you sure you want to unlink?')) return;try{await cleanCall(true);await api('/api/pair/unlink',{method:'POST',body:{}});notice('تم إلغاء الربط');await refresh();}catch(e){notice(e.message);}});
$('sosBtn').addEventListener('click',async()=>{
  if(!confirm(lang==='ar'?'ترسلين تنبيه SOS للطرف المرتبط؟ للحالات الجدية فقط.':'Send an SOS alert to your linked partner? For real emergencies only.'))return;
  try{const d=await api('/api/sos',{method:'POST',body:{}});notice(d.delivered?'🆘 تم تسجيل وإرسال تنبيه داخل التطبيق':'تم تسجيل التنبيه، لكن ما في طرف مرتبط');await loadAlerts();}catch(e){notice(e.message);}
});
function renderLocation(){
  if(!me||me.role!=='guardian')return;
  const loc=me.location&&me.location.sent+30*60_000>Date.now()?me.location:null;
  $('noLocation').hidden=!!loc;$('mapLink').hidden=!loc;$('locationTime').textContent=loc?new Date(loc.sent).toLocaleString(lang==='ar'?'ar-KW':'en-GB'):'';
  if(loc) $('mapLink').href=`https://www.google.com/maps?q=${encodeURIComponent(loc.lat)},${encodeURIComponent(loc.lng)}`;
}
$('shareLocation').addEventListener('click',()=>{
  if(!navigator.geolocation){notice('الموقع يحتاج HTTPS أو localhost ومتصفح يدعم الموقع');return;}
  $('shareLocation').disabled=true;
  navigator.geolocation.getCurrentPosition(async(position)=>{
    try{await api('/api/location/send',{method:'POST',body:{lat:position.coords.latitude,lng:position.coords.longitude}});notice('📍 تمت مشاركة الموقع مرة واحدة');}
    catch(e){notice(e.message);}finally{$('shareLocation').disabled=false;}
  },(error)=>{notice('تعذر تحديد الموقع: '+error.message);$('shareLocation').disabled=false;},{enableHighAccuracy:true,timeout:15000,maximumAge:0});
});

$('requestLive').addEventListener('click',async()=>{
  try{const d=await api('/api/call/request',{method:'POST',body:{}});callId=d.id;$('requestPending').hidden=false;notice('تم إرسال طلب البث — ننتظر الموافقة');}
  catch(e){notice(e.message);}
});
$('cancelLive').addEventListener('click',()=>cleanCall(true));
$('endGuardianLive').addEventListener('click',()=>cleanCall(true));
$('endChildLive').addEventListener('click',()=>cleanCall(true));
$('rejectLive').addEventListener('click',async()=>{
  try{await api('/api/call/reject',{method:'POST',body:{id:callId}});await cleanCall(false);notice('تم رفض الطلب');await refresh();}catch(e){notice(e.message);}
});
$('acceptLive').addEventListener('click',async()=>{
  if(!callId){notice('طلب البث غير موجود');return;}
  if(!navigator.mediaDevices?.getUserMedia){notice('الكاميرا والمايك يحتاجون HTTPS أو localhost');return;}
  const btn=$('acceptLive');btn.disabled=true;
  try {
    localStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:{echoCancellation:true,noiseSuppression:true}});
    $('localVideo').srcObject=localStream;ui.localWrap.hidden=false;ui.incoming.hidden=true;
    await api('/api/call/accept',{method:'POST',body:{id:callId}});
    await startChildOffer(callId);
    notice('🎥 🎙️ البث شغّال — تقدرين توقفينه بأي وقت');
  }catch(e){
    await cleanCall(true);
    notice(e.name==='NotAllowedError'?'الكاميرا أو المايك مو مسموح لهم، البث ما بدأ':e.message);
  }finally{btn.disabled=false;}
});
function createPeer(){
  if(pc) return pc;
  remoteCandidateQueue=[];
  pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]});
  pc.onicecandidate=(e)=>{if(e.candidate&&callId) sendSignal(callId,{type:'candidate',candidate:e.candidate.toJSON()}).catch(console.warn);};
  pc.onconnectionstatechange=()=>{
    const s=pc?.connectionState;
    if(s==='failed') notice('تعذر اتصال الفيديو بين الجهازين. قد تحتاج الشبكة لخادم TURN.');
    if(s==='disconnected') notice('انقطع الاتصال مؤقتًا');
  };
  pc.ontrack=(e)=>{
    if(me?.role!=='guardian')return;
    const video=$('remoteVideo');
    video.srcObject=e.streams[0];ui.remoteWrap.hidden=false;
    video.play().catch(()=>notice('اضغطي تشغيل على الفيديو للسماح بالصوت'));
  };
  return pc;
}
async function startChildOffer(id){
  const peer=createPeer();
  if(!localStream)throw new Error('لا يوجد إذن للبث');
  for(const t of localStream.getTracks()) peer.addTrack(t,localStream);
  const offer=await peer.createOffer();await peer.setLocalDescription(offer);
  await sendSignal(id,{type:'offer',sdp:peer.localDescription.sdp});
}
async function sendSignal(id,signal){return await api('/api/call/signal',{method:'POST',body:{id,signal}});}
async function onSignal({id,signal}){
  if(!me||!id||!signal)return;
  if(callId!==id)callId=id;
  try{
    const peer=createPeer();
    if(signal.type==='offer'){
      if(me.role!=='guardian')return;
      await peer.setRemoteDescription({type:'offer',sdp:signal.sdp});
      const answer=await peer.createAnswer();await peer.setLocalDescription(answer);
      await sendSignal(id,{type:'answer',sdp:peer.localDescription.sdp});
      await flushCandidates();
    } else if(signal.type==='answer'){
      if(me.role!=='child')return;
      await peer.setRemoteDescription({type:'answer',sdp:signal.sdp});await flushCandidates();
    } else if(signal.type==='candidate'){
      if(peer.remoteDescription)await peer.addIceCandidate(signal.candidate);
      else remoteCandidateQueue.push(signal.candidate);
    }
  }catch(e){console.error('Live signal error:',e);notice('خطأ في ربط الفيديو: '+e.message);}
}
async function flushCandidates(){const queue=remoteCandidateQueue.splice(0);for(const c of queue)await pc?.addIceCandidate(c);}
async function cleanCall(notifyServer){
  const id=callId; callId=null;
  if(pc){const closing=pc;pc=null;try{closing.close();}catch{}}
  if(localStream){for(const t of localStream.getTracks())t.stop();localStream=null;}
  $('localVideo').srcObject=null;$('remoteVideo').srcObject=null;
  ui.localWrap.hidden=true;ui.remoteWrap.hidden=true;ui.incoming.hidden=true;$('requestPending').hidden=true;remoteCandidateQueue=[];
  if(notifyServer&&id&&me)try{await api('/api/call/end',{method:'POST',body:{id}});}catch(e){console.warn(e.message);}
}
window.addEventListener('pagehide',()=>{if(localStream){for(const t of localStream.getTracks())t.stop();}});
(async()=>{setAuthMode('login');await refresh();if(me)connectEvents();})();
