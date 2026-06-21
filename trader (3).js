/* ═══════════════════════════════════════════════════════════════
   NORTH POINTE CAPITAL — GitHub Actions Trading Engine
   Runs every 15 minutes via GitHub Actions schedule
   Saves all state to trades.json in your repo
   ═══════════════════════════════════════════════════════════════ */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const KALSHI_BASE  = 'https://external-api.demo.kalshi.co/trade-api/v2';
const KALSHI_KEY   = process.env.KALSHI_KEY   || 'b4ec0f5c-a607-4063-9b9f-db2dd4bea774';
const KALSHI_EMAIL = process.env.KALSHI_EMAIL || '';
const KALSHI_PASS  = process.env.KALSHI_PASS  || '';
const FH_KEY       = process.env.FH_KEY       || 'd8dku89r01qhm4aflaf0d8dku89r01qhm4aflafg';
const NEWS_KEY     = process.env.NEWS_KEY     || 'b1d8a1d1e49c34471e4c3d520fb4401b';
const DATA_FILE    = path.join(process.cwd(), 'trades.json');
let   sessionToken  = null;

console.log('╔══════════════════════════════════════════╗');
console.log('║   NORTH POINTE CAPITAL — Trading Engine  ║');
console.log('║   GitHub Actions Run —', new Date().toISOString(), '║');
console.log('╚══════════════════════════════════════════╝');

/* ── Load or initialize state ── */
let STATE;
try {
  STATE = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  console.log(`[State] Loaded — Cash: $${STATE.cash} · Trades: ${STATE.trades.length} · Positions: ${STATE.positions.length}`);
} catch(e) {
  console.log('[State] No existing state — starting fresh with $200');
  STATE = {
    cash: 200, startCash: 200,
    trades: [], positions: [], log: [],
    markets: [], prices: {},
    tick: 0, totalScanned: 0,
    learnData: {}, learnAdjust: {}, learnTotal: 0,
    lastRun: null, created: new Date().toISOString()
  };
}

/* ── HTTP helper ── */
function request(options, body=null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    if(body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function kalshiLogin() {
  if(sessionToken) return true; /* already logged in this run */
  if(!KALSHI_EMAIL || !KALSHI_PASS) {
    console.log('[Auth] No KALSHI_EMAIL/KALSHI_PASS set — orders will likely fail');
    return false;
  }
  try {
    const r = await request({
      hostname: 'external-api.demo.kalshi.co',
      path: '/trade-api/v2/login',
      method: 'POST',
      headers: { 'Content-Type':'application/json' }
    }, { email: KALSHI_EMAIL, password: KALSHI_PASS });
    if(r.status===200 && r.body.token) {
      sessionToken = r.body.token;
      console.log('[Auth] ✓ Kalshi demo login successful');
      return true;
    }
    console.log('[Auth] ✗ Login failed:', r.status, JSON.stringify(r.body).substring(0,150));
    return false;
  } catch(e) {
    console.log('[Auth] ✗ Login error:', e.message);
    return false;
  }
}

function kalshiReq(method, p, body=null) {
  return request({
    hostname: 'external-api.demo.kalshi.co',
    path: '/trade-api/v2' + p, method,
    headers: {
      'Content-Type':'application/json',
      'Authorization': sessionToken ? 'Bearer '+sessionToken : 'Bearer '+KALSHI_KEY
    }
  }, body);
}

/* ── Kalshi Field Normalizer ──────────────────────────────────
   Kalshi migrated to fixed-point dollar-string fields in March 2026.
   Old: yes_bid (integer cents), close_time
   New: yes_bid_dollars ("0.6500"), latest_expiration_time, volume_fp
   This converts new-format markets back to the numbers our scoring
   logic expects, while staying backward compatible with old format.
──────────────────────────────────────────────────────────── */
function normalizeMarket(m) {
  const yesBid = m.yes_bid !== undefined ? m.yes_bid
               : m.yes_bid_dollars !== undefined ? parseFloat(m.yes_bid_dollars)
               : 0.5;
  const closeTime = m.close_time || m.latest_expiration_time || m.expiration_time || null;
  const volume = m.volume !== undefined ? m.volume
               : m.volume_fp !== undefined ? parseFloat(m.volume_fp)
               : 0;
  return {
    ...m,
    yes_bid: yesBid,
    close_time: closeTime,
    expiration_time: closeTime,
    volume: volume,
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts    = () => new Date().toLocaleTimeString();

function addLog(who, msg, type='') {
  const entry = { t: ts(), who, msg, type };
  STATE.log.unshift(entry);
  if(STATE.log.length > 200) STATE.log.pop();
  console.log(`[${who}] ${msg}`);
}

/* ── Finnhub prices ── */
async function refreshPrices() {
  const symbols = [
    'BINANCE:BTCUSDT','BINANCE:ETHUSDT','BINANCE:SOLUSDT',
    'SPY','QQQ','GLD','AAPL','USO'
  ];
  let ok = 0;
  for(const sym of symbols) {
    try {
      const r = await request({
        hostname:'finnhub.io',
        path:`/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${FH_KEY}`,
        method:'GET', headers:{}
      });
      if(r.status===200 && r.body.c > 0) {
        STATE.prices[sym] = {
          c:r.body.c, pc:r.body.pc||r.body.c,
          pct:r.body.pc?((r.body.c-r.body.pc)/r.body.pc*100):0
        };
        ok++;
      }
    } catch(e) {}
    await sleep(100);
  }
  addLog('Nova', `Finnhub: ${ok} prices — BTC $${pStr('BINANCE:BTCUSDT')} SPY $${pStr('SPY')}`, 'lt-info');
}

function pStr(sym) {
  const p = STATE.prices[sym];
  if(!p) return '?';
  return p.c>=1000?'$'+Math.round(p.c).toLocaleString():'$'+p.c.toFixed(2);
}

/* ── NewsAPI ── */
let headlines = [];
async function refreshNews() {
  try {
    const q = encodeURIComponent('bitcoin stocks economy federal reserve sports politics');
    const r = await request({
      hostname:'newsapi.org',
      path:`/v2/everything?q=${q}&language=en&sortBy=publishedAt&pageSize=6&apiKey=${NEWS_KEY}`,
      method:'GET', headers:{}
    });
    if(r.status===200 && r.body.status==='ok') {
      headlines = (r.body.articles||[]).map(a=>a.title).filter(Boolean);
      addLog('Nova', `NewsAPI: ${headlines.length} headlines`, 'lt-info');
    }
  } catch(e) { addLog('Nova','NewsAPI: '+e.message,'lt-warn'); }
}

/* ── Scoring helpers ── */
function newsBoost(m) {
  if(!headlines.length) return 0;
  const cat=(m.category||'').toLowerCase(), all=headlines.join(' ').toLowerCase();
  const kws={crypto:['bitcoin','crypto','ethereum'],finance:['stock','market','nasdaq'],
    economics:['fed','inflation','cpi'],politics:['senate','congress','tariff'],
    sports:['nba','nfl','mlb'],weather:['weather','hurricane']};
  for(const k of (kws[cat]||[])) if(all.includes(k)) return 1;
  return 0;
}

function learnBoost(cat, side, term) {
  return STATE.learnAdjust[`${cat}|${side}|${term}`]||1.0;
}

function edgeEstimate(conf, score) {
  const base=conf==='high'?0.08:conf==='med'?0.05:0.02;
  const bonus=score>=10?0.03:score>=8?0.02:0.01;
  return Math.min(base+bonus, 0.15);
}

function kellyFraction(p_true, marketPrice) {
  const b=(1/marketPrice)-1;
  if(b<=0||p_true<=0) return 0;
  const f=(p_true*b-(1-p_true))/b;
  return f<=0?0:Math.min(f*0.5*100, 15);
}

function kellySize(price, cash, conf, score, cashFloor) {
  const edge=edgeEstimate(conf,score);
  const p=Math.min(price+edge,0.97);
  const fPct=kellyFraction(p,price);
  const raw=(fPct/100)*cash;
  const cap=(1/price)>4?20:(1/price)>2?16:12;
  const floor=cashFloor!==undefined?cashFloor:5;
  /* Floor $2 minimum, ceiling = cap, never dip below the cash reserve floor */
  return Math.min(Math.max(parseFloat(raw.toFixed(2)), 2), cap, cash-floor);
}

function isShort(m) {
  const t=new Date(m.close_time||m.expiration_time||Date.now()+999*86400000);
  return (t-Date.now())/3600000<=72;
}

function timeLeft(m) {
  const t=new Date(m.close_time||m.expiration_time||Date.now()+999*86400000);
  const h=(t-Date.now())/3600000;
  if(h<0) return 'expired';
  if(h<1) return Math.round(h*60)+'min';
  if(h<48) return h.toFixed(1)+'h';
  return Math.round(h/24)+'d';
}

function betSanityKill(m) {
  const title=(m.title||'').toLowerCase();
  const close=new Date(m.close_time||m.expiration_time||Date.now()+999*86400000).getTime();
  const hoursLeft=(close-Date.now())/3600000;
  if(hoursLeft<0) return 'Expired';
  if(hoursLeft<0.33) return 'Under 20min';
  const btc=STATE.prices['BINANCE:BTCUSDT'];
  if(btc&&(title.includes('bitcoin')||title.includes('btc'))) {
    const nums=title.match(/[\d,]+k?\b/g)||[];
    for(const n of nums) {
      const v=parseFloat(n.replace(/,/g,''))*(n.endsWith('k')?1000:1);
      if(v<1000) continue;
      const isAbove=title.includes('above')||title.includes('over');
      const gap=(v-btc.c)/btc.c*100;
      if(isAbove&&gap>5&&hoursLeft<24) return `BTC needs +${gap.toFixed(1)}% in ${hoursLeft.toFixed(1)}h`;
      if(isAbove&&gap>20&&hoursLeft<168) return `BTC needs +${gap.toFixed(1)}% in 7d`;
    }
  }
  return null;
}

function scoreMarket(m) {
  const kill=betSanityKill(m);
  if(kill) return {killed:true,killReason:kill};
  const yesBid=parseFloat(m.yes_bid||0.5);
  const noBid=1-yesBid;
  const vol=m.volume||0;
  const cat=(m.category||'').toLowerCase();
  const title=(m.title||'').toLowerCase();
  const term=isShort(m)?'short':'long';
  let fhSig=0;
  const btc=STATE.prices['BINANCE:BTCUSDT'],spy=STATE.prices['SPY'];
  if(cat==='crypto'&&btc) fhSig+=btc.pct>3?2:btc.pct>1?1:btc.pct<-3?-2:btc.pct<-1?-1:0;
  if(cat==='finance'&&spy) fhSig+=spy.pct>1.5?2:spy.pct>0.5?1:spy.pct<-1.5?-2:spy.pct<-0.5?-1:0;
  const isUpBet=/above|higher|positive|up |gain|rise|increase|over/.test(title);
  let side,impliedProb,reasoning;
  if(isUpBet&&cat==='crypto'&&fhSig<=-2){side='NO';impliedProb=noBid;reasoning='NO: Finnhub bearish';}
  else if(isUpBet&&cat==='finance'&&fhSig<=-2){side='NO';impliedProb=noBid;reasoning='NO: SPY bearish';}
  else if(yesBid>=0.5){side='YES';impliedProb=yesBid;reasoning=`YES: ${(yesBid*100).toFixed(0)}¢`;}
  else{side='NO';impliedProb=noBid;reasoning=`NO: ${(noBid*100).toFixed(0)}¢`;}
  if(impliedProb<0.60) return null;
  let score=impliedProb>0.90?8:impliedProb>0.85?7:impliedProb>0.80?6:
            impliedProb>0.75?5:impliedProb>0.70?4:impliedProb>0.65?3:2;
  const payoutMult=1/impliedProb;
  const ev=impliedProb*(payoutMult-1)-(1-impliedProb);
  if(ev>1.0)score+=3;else if(ev>0.5)score+=2;else if(ev>0.2)score+=1;
  if(vol>6000)score+=2;else if(vol>2000)score+=1;
  score+=newsBoost(m);
  if(side==='YES'&&fhSig>0)score+=Math.min(fhSig,2);
  if(side==='NO'&&fhSig<0)score+=Math.min(Math.abs(fhSig),2);
  if(side==='YES'&&fhSig<-1)score-=2;
  score=Math.round(score*learnBoost(m.category,side,term));
  const conf=score>=9?'high':score>=7?'med':score>=5?'low':'skip';
  if(conf==='skip') return null;
  const rec=score>=9?'Strong BUY':score>=7?'BUY':'Watch';
  return{yesBid,side,impliedProb,score,conf,rec,reasoning,killed:false,term,fhSig};
}

function learnRecord(trade) {
  const key=`${trade.category}|${trade.side}|${trade.term}`;
  if(!STATE.learnData[key]) STATE.learnData[key]={wins:0,total:0};
  STATE.learnData[key].total++;
  if(trade.status==='win') STATE.learnData[key].wins++;
  STATE.learnTotal++;
  const wr=STATE.learnData[key].wins/STATE.learnData[key].total;
  STATE.learnAdjust[key]=wr>0.65?Math.min(1.4,1+(wr-0.65)*2):wr<0.40?Math.max(0.6,1-(0.40-wr)*2):1.0;
}

/* ══════════════════════════════════════════════
   MAIN TRADING RUN
   ══════════════════════════════════════════════ */
async function run() {
  STATE.tick++;
  STATE.lastRun = new Date().toISOString();
  addLog('System',`═══ TICK #${STATE.tick} — North Pointe Capital ═══`,'lt-sys');

  /* 0. Login to Kalshi demo FIRST — required for real orders */
  const loggedIn = await kalshiLogin();
  addLog('Auth', loggedIn ? '✓ Kalshi demo session active' : '✗ No session — orders may be rejected (check KALSHI_EMAIL/KALSHI_PASS secrets)', loggedIn?'lt-info':'lt-warn');

  /* 1. Refresh prices and news */
  await refreshPrices();
  await refreshNews();

  /* 2. REX — fetch real Kalshi markets */
  addLog('Rex','Scanning Kalshi demo markets...');
  try {
    const r=await kalshiReq('GET','/markets?status=open&limit=100');
    if(r.status===200&&r.body.markets?.length) {
      STATE.markets=r.body.markets.filter(m=>m.title).map(normalizeMarket);
      STATE.totalScanned+=STATE.markets.length;
      addLog('Rex',`Got ${STATE.markets.length} REAL live markets`,'lt-info');
    } else {
      addLog('Rex',`Kalshi returned ${r.status}: ${JSON.stringify(r.body).substring(0,100)}`,'lt-warn');
    }
  } catch(e){ addLog('Rex','Error: '+e.message,'lt-warn'); }

  if(!STATE.markets.length) {
    addLog('System','No markets available — skipping this run','lt-warn');
    saveState(); return;
  }

  /* 3. FLASH + SAGE — score markets */
  const held=new Set(STATE.positions.map(p=>p.ticker));
  const cands=[];
  let killed=0;
  for(const m of STATE.markets) {
    if(held.has(m.ticker)) continue;
    const a=scoreMarket(m);
    if(!a) continue;
    if(a.killed){killed++;continue;}
    if(a.rec==='Watch') continue;
    cands.push({m,a,termType:isShort(m)?'short':'long'});
  }
  cands.sort((a,b)=>b.a.score-a.a.score);
  addLog('Flash',`${cands.filter(x=>x.termType==='short').length} short · ${cands.filter(x=>x.termType==='long').length} long · YES:${cands.filter(x=>x.a.side==='YES').length} NO:${cands.filter(x=>x.a.side==='NO').length} (${killed} killed)`);

  /* 4. NOVA — diversify into 4 buckets */
  const B={
    sY:cands.filter(x=>x.termType==='short'&&x.a.side==='YES').sort((a,b)=>b.a.score-a.a.score),
    sN:cands.filter(x=>x.termType==='short'&&x.a.side==='NO').sort((a,b)=>b.a.score-a.a.score),
    lY:cands.filter(x=>x.termType==='long'&&x.a.side==='YES').sort((a,b)=>b.a.score-a.a.score),
    lN:cands.filter(x=>x.termType==='long'&&x.a.side==='NO').sort((a,b)=>b.a.score-a.a.score),
  };
  const usedCats=new Set(),seen=new Set(),approved=[];
  const order=[B.sY,B.lY,B.sN,B.lN];
  for(let round=0;round<4&&approved.length<8;round++) {
    for(const pool of order) {
      if(approved.length>=8) break;
      let pick=pool.find(x=>!seen.has(x.m.ticker)&&!usedCats.has(x.m.category));
      if(!pick) pick=pool.find(x=>!seen.has(x.m.ticker));
      if(!pick) continue;
      seen.add(pick.m.ticker);usedCats.add(pick.m.category);approved.push(pick);
    }
  }

  /* 5. AXEL — Kelly sizing + balance */
  const dep=STATE.positions.reduce((s,p)=>s+p.size,0);
  const expPct=(dep/STATE.startCash*100);
  addLog('Axel',`Exposure: ${expPct.toFixed(0)}% · Cash: $${STATE.cash.toFixed(2)}`);
  const eligible=approved.filter(x=>x.a.conf==='high'||x.a.conf==='med');
  const toPlace=[];
  /* Stop opening NEW trades once cash drops below $25 — prevents tiny
     forced $2 bets that happen when cash-5 becomes the binding constraint.
     Let existing positions settle and free up cash before deploying more. */
  /* Stop opening NEW trades once cash drops below 30% of starting cash —
     prevents tiny forced $2 bets that happen when the cash-reserve floor
     becomes the binding constraint. Lets existing positions settle and
     free up cash before deploying more. Target: 70% deployed / 30% cash. */
  const cashFloor = STATE.startCash * 0.30;
  if(STATE.cash < cashFloor) {
    addLog('Axel',`Cash reserve hit ($${STATE.cash.toFixed(2)} < $${cashFloor.toFixed(2)} floor) — holding until positions settle`,'lt-warn');
  } else if(expPct<70) {
    const counts={short:0,long:0,YES:0,NO:0};
    for(const x of eligible) {
      if(toPlace.length>=4) break;
      if(STATE.cash - toPlace.reduce((s,p)=>s+(p._kSize||0),0) < cashFloor) break;
      if(counts[x.termType]>=2||counts[x.a.side]>=2) continue;
      const kSize=kellySize(x.a.impliedProb,STATE.cash,x.a.conf,x.a.score,cashFloor);
      const winP=Math.min(x.a.impliedProb+edgeEstimate(x.a.conf,x.a.score),0.96);
      const profitW=((kSize)*(1/x.a.impliedProb-1)).toFixed(2);
      addLog('Axel',
        `PRE-TRADE: ${x.a.side} "${x.m.title.substring(0,28)}" · `+
        `$${kSize.toFixed(2)} · win ${(winP*100).toFixed(0)}% · profit if win: +$${profitW}`,'lt-kelly');
      x._kSize=kSize;
      counts[x.termType]++;counts[x.a.side]++;toPlace.push(x);
    }
  } else {
    addLog('Axel','Exposure cap 70% — holding','lt-warn');
  }

  /* 6. ZARA — place real orders */
  for(const {m,a,termType,_kSize} of toPlace) {
    const size=_kSize||kellySize(a.impliedProb,STATE.cash,a.conf,a.score,STATE.startCash*0.30);
    if(size<1||STATE.cash<size+2){addLog('Zara','Skip '+m.ticker+' — cash low','lt-warn');continue;}
    const orderBody={
      ticker:m.ticker, side:a.side.toLowerCase(), action:'buy',
      count:Math.max(1,Math.floor(size/a.impliedProb)),
      type:'market',
      client_order_id:`NPC-${Date.now()}-${Math.random().toString(36).substr(2,6)}`
    };
    try {
      const r=await kalshiReq('POST','/orders',orderBody);
      if(r.status===200||r.status===201) {
        addLog('Zara',`✅ REAL ORDER: ${a.side} ${m.ticker} · $${size.toFixed(2)} @ ${(a.impliedProb*100).toFixed(0)}¢`,'lt-trade');
      } else {
        addLog('Zara',`Order rejected (${r.status}): ${JSON.stringify(r.body).substring(0,60)}`,'lt-warn');
      }
    } catch(e){ addLog('Zara','Order error: '+e.message,'lt-warn'); }
    STATE.cash=parseFloat((STATE.cash-size).toFixed(2));
    const ev=(a.impliedProb*(1/a.impliedProb-1)-(1-a.impliedProb));
    const trade={
      id:Date.now()+Math.random(), ticker:m.ticker,
      market:m.title||m.ticker, category:m.category||'Unknown',
      agent:'Zara', side:a.side,
      entryPrice:a.impliedProb, currentPrice:a.impliedProb,
      size, pnl:0, status:'open',
      openedAt:new Date().toISOString(), closedAt:null, ticksOpen:0,
      conf:a.conf, shortTerm:termType==='short', term:termType,
      expires:m.close_time||m.expiration_time||null,
      reasoning:a.reasoning||'',
      kellyFrac:kellyFraction(Math.min(a.impliedProb+edgeEstimate(a.conf,a.score),0.97),a.impliedProb).toFixed(1),
      payoutMult:(1/a.impliedProb).toFixed(2),
      expectedReturn:(ev*100).toFixed(1),
      entryScore:a.score
    };
    STATE.trades.push(trade);
    STATE.positions.push({...trade});
    await sleep(300);
  }

  /* 7. KNOX — check real settlement */
  addLog('Knox',`Checking ${STATE.positions.length} position(s) for settlement...`);
  for(const pos of STATE.positions) pos.ticksOpen=(pos.ticksOpen||0)+1;
  const toClose=[];
  for(const pos of STATE.positions) {
    try {
      const r=await kalshiReq('GET',`/markets/${pos.ticker}`);
      if(r.status===200&&r.body.market) {
        const mkt=r.body.market;
        const mktYesBid = mkt.yes_bid !== undefined ? mkt.yes_bid
                         : mkt.yes_bid_dollars !== undefined ? parseFloat(mkt.yes_bid_dollars)
                         : null;
        if(mktYesBid !== null) {
          pos.currentPrice=mktYesBid;
          const mt=STATE.trades.find(t=>t.id===pos.id);
          if(mt) mt.currentPrice=pos.currentPrice;
        }
        if(mkt.status==='settled'&&mkt.result) {
          const won=(pos.side==='YES'&&mkt.result==='yes')||(pos.side==='NO'&&mkt.result==='no');
          const payout=won?parseFloat((pos.size/pos.entryPrice).toFixed(2)):0;
          const pnl=parseFloat((payout-pos.size).toFixed(2));
          toClose.push({pos,won,pnl,result:mkt.result});
          addLog('Knox',`[REAL SETTLE] ${pos.ticker} → ${mkt.result.toUpperCase()} ${won?'WIN ✓':'LOSS ✗'}`,'lt-info');
        } else {
          addLog('Knox',`${pos.ticker} open · mark ${(pos.currentPrice*100).toFixed(0)}¢ · ~${timeLeft({close_time:pos.expires})} left`);
        }
      }
    } catch(e){ addLog('Knox','Error: '+e.message,'lt-warn'); }
    await sleep(200);
  }
  for(const {pos,won,pnl} of toClose) {
    STATE.cash=parseFloat((STATE.cash+pos.size+pnl).toFixed(2));
    const mt=STATE.trades.find(t=>t.id===pos.id);
    if(mt){mt.pnl=pnl;mt.status=won?'win':'loss';mt.closedAt=new Date().toISOString();learnRecord(mt);}
    STATE.positions=STATE.positions.filter(p=>p.id!==pos.id);
    addLog('Knox',`${won?'✓ WIN':'✗ LOSS'} "${pos.market.substring(0,30)}" → ${pnl>=0?'+':''}$${Math.abs(pnl).toFixed(2)}`,won?'lt-trade':'lt-err');
  }
  if(!toClose.length) addLog('Knox',`All ${STATE.positions.length} positions pending real Kalshi settlement`);

  /* Summary */
  const pnl=STATE.trades.filter(t=>t.status!=='open').reduce((s,t)=>s+t.pnl,0);
  const port=STATE.cash+STATE.positions.reduce((s,p)=>s+p.size,0);
  addLog('System',`Portfolio: $${port.toFixed(2)} · Realized P&L: ${pnl>=0?'+':''}$${pnl.toFixed(2)} · Trades: ${STATE.trades.length}`,'lt-sys');

  saveState();
}

function saveState() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(STATE, null, 2));
  console.log(`[System] State saved to ${DATA_FILE}`);
  console.log(`[System] Trades: ${STATE.trades.length} · Positions: ${STATE.positions.length} · Cash: $${STATE.cash}`);
}

/* Run */
run().catch(e => {
  console.error('Fatal error:', e);
  saveState();
  process.exit(1);
});
