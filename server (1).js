/* ═══════════════════════════════════════════════════════════════
   NORTH POINTE CAPITAL — Kalshi AI Trading Server
   ═══════════════════════════════════════════════════════════════
   Runs 24/7 on Railway. Handles:
     1. Kalshi demo login + session management
     2. Full 7-agent trading pipeline (Rex → Knox)
     3. Real order placement on Kalshi demo
     4. Real settlement checking
     5. Finnhub live prices
     6. NewsAPI headlines
     7. Dashboard API so your HTML sees everything
     8. CORS proxy so browser calls work cleanly
   ═══════════════════════════════════════════════════════════════ */

const http    = require('http');
const https   = require('https');
const url     = require('url');
const crypto  = require('crypto');

/* ── Config ─────────────────────────────────────────────── */
const PORT          = process.env.PORT || 3000;
const KALSHI_BASE   = 'https://external-api.demo.kalshi.co/trade-api/v2';
const KALSHI_EMAIL  = process.env.KALSHI_EMAIL  || '';
const KALSHI_PASS   = process.env.KALSHI_PASS   || '';
const KALSHI_KEY    = process.env.KALSHI_KEY    || 'b4ec0f5c-a607-4063-9b9f-db2dd4bea774';
const FH_KEY        = process.env.FH_KEY        || 'd8dku89r01qhm4aflaf0d8dku89r01qhm4aflafg';
const NEWS_KEY      = process.env.NEWS_KEY      || 'b1d8a1d1e49c34471e4c3d520fb4401b';
const TICK_MS       = 20000; /* 20 seconds per agent cycle */

console.log('╔══════════════════════════════════════════╗');
console.log('║   NORTH POINTE CAPITAL — Trading Server  ║');
console.log('║   Kalshi AI Trading Desk — v6.0          ║');
console.log('╚══════════════════════════════════════════╝');

/* ── State ───────────────────────────────────────────────── */
const STATE = {
  running:    false,
  paused:     false,
  cash:       200.00,
  startCash:  200.00,
  trades:     [],
  positions:  [],
  log:        [],
  markets:    [],
  prices:     {},
  headlines:  [],
  tick:       0,
  sessionToken: null,
  sessionExpiry: 0,
  totalScanned: 0,
  pairs:      [],
  learnData:  {},
  learnAdjust:{},
  learnTotal: 0,
};

/* ── Logger ──────────────────────────────────────────────── */
function log(who, msg, type='') {
  const entry = { t: new Date().toLocaleTimeString(), who, msg, type };
  STATE.log.unshift(entry);
  if(STATE.log.length > 500) STATE.log.pop();
  console.log(`[${who}] ${msg}`);
}

/* ── HTTP Helper ─────────────────────────────────────────── */
function request(options, body=null) {
  return new Promise((resolve, reject) => {
    const mod = options.protocol === 'http:' ? http : https;
    const req = mod.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
    if(body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function kalshiRequest(method, path, body=null) {
  const opts = {
    hostname: 'external-api.demo.kalshi.co',
    path: '/trade-api/v2' + path,
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': STATE.sessionToken
        ? `Bearer ${STATE.sessionToken}`
        : `Bearer ${KALSHI_KEY}`,
    }
  };
  return request(opts, body);
}

/* ── Kalshi Auth ─────────────────────────────────────────── */
async function kalshiLogin() {
  if(!KALSHI_EMAIL || !KALSHI_PASS) {
    log('Auth', 'No email/pass set — using API key auth only');
    return false;
  }
  if(STATE.sessionToken && Date.now() < STATE.sessionExpiry) return true;
  try {
    const r = await request({
      hostname: 'external-api.demo.kalshi.co',
      path: '/trade-api/v2/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { email: KALSHI_EMAIL, password: KALSHI_PASS });
    if(r.status === 200 && r.body.token) {
      STATE.sessionToken = r.body.token;
      STATE.sessionExpiry = Date.now() + 25 * 60 * 1000; /* 25 min */
      log('Auth', 'Kalshi demo login successful — session valid 25min', 'lt-info');
      return true;
    }
    log('Auth', `Login failed: ${JSON.stringify(r.body)}`, 'lt-warn');
    return false;
  } catch(e) {
    log('Auth', 'Login error: ' + e.message, 'lt-warn');
    return false;
  }
}

/* ── Finnhub Prices ──────────────────────────────────────── */
const FH_SYMBOLS = [
  {sym:'BINANCE:BTCUSDT',lbl:'BTC'}, {sym:'BINANCE:ETHUSDT',lbl:'ETH'},
  {sym:'BINANCE:SOLUSDT',lbl:'SOL'}, {sym:'SPY',lbl:'SPY'},
  {sym:'QQQ',lbl:'QQQ'}, {sym:'GLD',lbl:'GLD'},
  {sym:'AAPL',lbl:'AAPL'}, {sym:'USO',lbl:'USO'},
];

async function refreshPrices() {
  let ok = 0;
  for(const s of FH_SYMBOLS) {
    try {
      const r = await request({
        hostname: 'finnhub.io',
        path: `/api/v1/quote?symbol=${encodeURIComponent(s.sym)}&token=${FH_KEY}`,
        method: 'GET',
        headers: {}
      });
      if(r.status===200 && r.body.c && r.body.c > 0) {
        STATE.prices[s.sym] = {
          c: r.body.c, pc: r.body.pc||r.body.c,
          pct: r.body.pc ? ((r.body.c-r.body.pc)/r.body.pc*100) : 0,
          h: r.body.h, l: r.body.l
        };
        ok++;
      }
    } catch(e) {}
    await sleep(80);
  }
  if(ok > 0) log('Nova', `Finnhub: ${ok} prices live — BTC $${pStr('BINANCE:BTCUSDT')} SPY $${pStr('SPY')}`, 'lt-info');
  else log('Nova', 'Finnhub unavailable — using last known prices', 'lt-warn');
}

function pStr(sym) {
  const p = STATE.prices[sym];
  if(!p) return '?';
  return p.c >= 1000 ? '$'+p.c.toLocaleString(undefined,{maximumFractionDigits:0}) : '$'+p.c.toFixed(2);
}

/* ── NewsAPI ─────────────────────────────────────────────── */
async function refreshNews() {
  try {
    const q = encodeURIComponent('bitcoin stocks economy federal reserve sports politics');
    const r = await request({
      hostname: 'newsapi.org',
      path: `/v2/everything?q=${q}&language=en&sortBy=publishedAt&pageSize=8&apiKey=${NEWS_KEY}`,
      method: 'GET', headers: {}
    });
    if(r.status===200 && r.body.status==='ok') {
      STATE.headlines = (r.body.articles||[]).map(a=>a.title).filter(Boolean);
      log('Nova', `NewsAPI: ${STATE.headlines.length} headlines loaded`, 'lt-info');
    }
  } catch(e) { log('Nova', 'NewsAPI error: '+e.message, 'lt-warn'); }
}

/* ── Helpers ─────────────────────────────────────────────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts    = () => new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});

function catClass(c) {
  return {Crypto:'cat-crypto',Finance:'cat-finance',Sports:'cat-sports',
          Politics:'cat-politics',Weather:'cat-weather',Economics:'cat-econ',
          'Pop Culture':'cat-pop'}[c]||'cat-finance';
}

/* ── Scoring ─────────────────────────────────────────────── */
function betSanityKill(market) {
  const title = (market.title||'').toLowerCase();
  const close = new Date(market.close_time||market.expiration_time||Date.now()+999*86400000).getTime();
  const hoursLeft = (close-Date.now())/3600000;
  if(hoursLeft < 0)    return 'Market expired';
  if(hoursLeft < 0.33) return 'Under 20min — too late';
  const btc = STATE.prices['BINANCE:BTCUSDT'];
  const eth = STATE.prices['BINANCE:ETHUSDT'];
  const spy = STATE.prices['SPY'];
  if(btc && (title.includes('bitcoin')||title.includes('btc'))) {
    const nums = title.match(/[\d,]+k?\b/g)||[];
    for(const n of nums) {
      const v = parseFloat(n.replace(/,/g,''))*(n.toLowerCase().endsWith('k')?1000:1);
      if(v<1000) continue;
      const isAbove = title.includes('above')||title.includes('higher')||title.includes('over');
      const gap = (v-btc.c)/btc.c*100;
      if(isAbove && gap>5  && hoursLeft<24)  return `BTC $${Math.round(btc.c).toLocaleString()} needs +${gap.toFixed(1)}% in ${hoursLeft.toFixed(1)}h`;
      if(isAbove && gap>20 && hoursLeft<168) return `BTC needs +${gap.toFixed(1)}% in 7d — unrealistic`;
    }
  }
  if(eth && (title.includes('ethereum')||title.includes('eth'))) {
    const nums = title.match(/[\d,]+/g)||[];
    for(const n of nums) {
      const v = parseFloat(n.replace(/,/g,''));
      if(v<500||v>20000) continue;
      const gap = (v-eth.c)/eth.c*100;
      if(title.includes('above') && gap>8 && hoursLeft<48) return `ETH $${eth.c.toFixed(0)} needs +${gap.toFixed(1)}%`;
    }
  }
  if(spy && title.includes('spy')) {
    const nums = title.match(/\$[\d]+/g)||[];
    for(const n of nums) {
      const v = parseFloat(n.replace('$',''));
      if(v<300||v>900) continue;
      const gap=(v-spy.c)/spy.c*100;
      if(gap>5 && hoursLeft<24) return `SPY $${spy.c.toFixed(0)} needs +${gap.toFixed(1)}% today`;
    }
  }
  return null;
}

function newsBoost(m) {
  if(!STATE.headlines.length) return 0;
  const cat = (m.category||'').toLowerCase();
  const all = STATE.headlines.join(' ').toLowerCase();
  const kws = {
    crypto:['bitcoin','crypto','ethereum','blockchain'],
    finance:['stock','nasdaq','s&p','market'],
    economics:['fed','inflation','cpi','jobs','rate'],
    politics:['senate','congress','tariff','election'],
    sports:['nba','nfl','mlb','sport'],
    weather:['weather','hurricane','storm']
  };
  for(const k of (kws[cat]||[])) if(all.includes(k)) return 1;
  return 0;
}

function learnBoost(cat, side, term) {
  return STATE.learnAdjust[`${cat}|${side}|${term}`]||1.0;
}

function edgeEstimate(conf, score) {
  const base  = conf==='high'?0.08:conf==='med'?0.05:0.02;
  const bonus = score>=10?0.03:score>=8?0.02:0.01;
  return Math.min(base+bonus, 0.15);
}

function kellyFraction(p_true, marketPrice) {
  const b = (1/marketPrice)-1;
  if(b<=0||p_true<=0) return 0;
  const f = (p_true*b-(1-p_true))/b;
  if(f<=0) return 0;
  return Math.min(f*0.5*100, 15);
}

function kellySize(impliedProb, cash, conf, score) {
  const edge   = edgeEstimate(conf||'med', score||5);
  const p_true = Math.min(impliedProb+edge, 0.97);
  const fPct   = kellyFraction(p_true, impliedProb);
  const raw    = (fPct/100)*cash;
  const payout = 1/impliedProb;
  const cap    = payout>4?20:payout>2?16:12;
  return Math.min(Math.max(parseFloat(raw.toFixed(2)),2), cap, cash-5);
}

function isShort(m) {
  const t = new Date(m.close_time||m.expiration_time||Date.now()+999*86400000);
  return (t-Date.now())/3600000<=72;
}

function timeLeft(m) {
  const t = new Date(m.close_time||m.expiration_time||Date.now()+999*86400000);
  const h = (t-Date.now())/3600000;
  if(h<0) return 'expired';
  if(h<1) return Math.round(h*60)+'min';
  if(h<48) return h.toFixed(1)+'h';
  return Math.round(h/24)+'d';
}

function scoreMarket(m) {
  const kill = betSanityKill(m);
  if(kill) return {killed:true, killReason:kill};
  const yesBid = parseFloat(m.yes_bid||m.yes_ask||0.5);
  const noBid  = 1-yesBid;
  const vol    = m.volume||0;
  const cat    = (m.category||'').toLowerCase();
  const title  = (m.title||'').toLowerCase();
  const term   = isShort(m)?'short':'long';
  /* Finnhub signal */
  let fhSig=0;
  const btc=STATE.prices['BINANCE:BTCUSDT'], spy=STATE.prices['SPY'], qqq=STATE.prices['QQQ'];
  if(cat==='crypto'  && btc) fhSig+=btc.pct>3?2:btc.pct>1?1:btc.pct<-3?-2:btc.pct<-1?-1:0;
  if(cat==='finance' && spy) fhSig+=spy.pct>1.5?2:spy.pct>0.5?1:spy.pct<-1.5?-2:spy.pct<-0.5?-1:0;
  if(cat==='finance' && qqq) fhSig+=qqq.pct>1?1:qqq.pct<-1?-1:0;
  /* Side selection */
  const isUpBet=/above|higher|positive|up |gain|rise|increase|over/.test(title);
  let side, impliedProb, reasoning;
  if(isUpBet && cat==='crypto' && fhSig<=-2) {
    side='NO'; impliedProb=noBid; reasoning=`NO: Finnhub bearish BTC ${btc?btc.pct.toFixed(1):'?'}%`;
  } else if(isUpBet && cat==='finance' && fhSig<=-2) {
    side='NO'; impliedProb=noBid; reasoning=`NO: SPY/QQQ bearish ${spy?spy.pct.toFixed(1):'?'}%`;
  } else if(yesBid>=0.5) {
    side='YES'; impliedProb=yesBid; reasoning=`YES: ${(yesBid*100).toFixed(0)}¢ implied`;
  } else {
    side='NO'; impliedProb=noBid; reasoning=`NO: ${(noBid*100).toFixed(0)}¢ implied`;
  }
  if(impliedProb<0.60) return null;
  /* Score */
  let score = impliedProb>0.90?8:impliedProb>0.85?7:impliedProb>0.80?6:
              impliedProb>0.75?5:impliedProb>0.70?4:impliedProb>0.65?3:2;
  /* EV bonus */
  const payoutMult=1/impliedProb;
  const ev=impliedProb*(payoutMult-1)-(1-impliedProb);
  if(ev>1.0) score+=3; else if(ev>0.5) score+=2; else if(ev>0.2) score+=1;
  if(payoutMult<1.20 && impliedProb>0.85) score-=1;
  if(vol>6000) score+=2; else if(vol>2000) score+=1;
  score+=newsBoost(m);
  if(side==='YES'&&fhSig>0) score+=Math.min(fhSig,2);
  if(side==='NO' &&fhSig<0) score+=Math.min(Math.abs(fhSig),2);
  if(side==='YES'&&fhSig<-1) score-=2;
  if(side==='NO' &&fhSig>1)  score-=1;
  score=Math.round(score*learnBoost(m.category,side,term));
  const conf=score>=9?'high':score>=7?'med':score>=5?'low':'skip';
  if(conf==='skip') return null;
  const rec=score>=9?'Strong BUY':score>=7?'BUY':'Watch';
  return {yesBid,side,impliedProb,score,conf,rec,reasoning,killed:false,killReason:null,term,fhSig};
}

/* ── Learning Engine ─────────────────────────────────────── */
function learnRecord(trade) {
  const key=`${trade.category}|${trade.side}|${trade.term}`;
  if(!STATE.learnData[key]) STATE.learnData[key]={wins:0,total:0};
  STATE.learnData[key].total++;
  if(trade.status==='win') STATE.learnData[key].wins++;
  STATE.learnTotal++;
  const wr=STATE.learnData[key].wins/STATE.learnData[key].total;
  STATE.learnAdjust[key]=wr>0.65?Math.min(1.4,1+(wr-0.65)*2):wr<0.40?Math.max(0.6,1-(0.40-wr)*2):1.0;
  log('Nova',`Learning: [${key}] WR=${(wr*100).toFixed(0)}% mult=${STATE.learnAdjust[key].toFixed(2)}x`,'lt-learn');
}

/* ══════════════════════════════════════════════════════════
   7-AGENT TRADING PIPELINE
   Runs every 20 seconds, 24/7
   ══════════════════════════════════════════════════════════ */

/* ── REX: Fetch markets ── */
async function phaseRex() {
  log('Rex', `Scanning Kalshi demo markets (tick #${STATE.tick})`);
  try {
    const r = await kalshiRequest('GET', '/markets?status=open&limit=100');
    if(r.status===200 && r.body.markets?.length) {
      STATE.markets = r.body.markets.filter(m=>m.title);
      STATE.totalScanned += STATE.markets.length;
      const cats=[...new Set(STATE.markets.map(m=>m.category).filter(Boolean))];
      log('Rex',`Got ${STATE.markets.length} REAL live markets — ${cats.join(', ')}`,'lt-info');
    } else {
      log('Rex',`API returned ${r.status} — keeping ${STATE.markets.length} cached markets`,'lt-warn');
    }
  } catch(e) {
    log('Rex','Kalshi unreachable: '+e.message,'lt-warn');
  }
}

/* ── FLASH + SAGE: Score short and long term ── */
async function phaseFlashSage() {
  const stMkts=STATE.markets.filter(isShort);
  const ltMkts=STATE.markets.filter(m=>!isShort(m));
  log('Flash',`Short-term: ${stMkts.length} markets ≤72h`);
  log('Sage', `Long-term: ${ltMkts.length} markets`);
  const held=new Set(STATE.positions.map(p=>p.ticker));
  const cands=[]; let killed=0;
  for(const m of [...stMkts,...ltMkts]) {
    if(held.has(m.ticker)) continue;
    const a=scoreMarket(m);
    if(!a) continue;
    if(a.killed) { killed++; continue; }
    if(a.rec==='Watch') continue;
    log(isShort(m)?'Flash':'Sage',
      `${a.side==='NO'?'🔴 NO':'🟢 YES'} "${m.title.substring(0,34)}" — ${a.reasoning} (${a.score}pts)`);
    cands.push({m,a,termType:isShort(m)?'short':'long'});
  }
  cands.sort((a,b)=>b.a.score-a.a.score);
  STATE._cands=cands;
  log('Flash',`${cands.filter(x=>x.termType==='short').length} short · ${cands.filter(x=>x.termType==='long').length} long · YES:${cands.filter(x=>x.a.side==='YES').length} NO:${cands.filter(x=>x.a.side==='NO').length} (${killed} killed)`);
}

/* ── NOVA: Diversify into 4 buckets ── */
async function phaseNova() {
  const cands=STATE._cands||[];
  log('Nova',`Diversifying ${cands.length} signals — BTC ${pStr('BINANCE:BTCUSDT')} SPY ${pStr('SPY')} News:${STATE.headlines.length}`);
  const B={
    sY:cands.filter(x=>x.termType==='short'&&x.a.side==='YES').sort((a,b)=>b.a.score-a.a.score),
    sN:cands.filter(x=>x.termType==='short'&&x.a.side==='NO' ).sort((a,b)=>b.a.score-a.a.score),
    lY:cands.filter(x=>x.termType==='long' &&x.a.side==='YES').sort((a,b)=>b.a.score-a.a.score),
    lN:cands.filter(x=>x.termType==='long' &&x.a.side==='NO' ).sort((a,b)=>b.a.score-a.a.score),
  };
  const usedCats=new Set(),seen=new Set(),merged=[];
  const order=[B.sY,B.lY,B.sN,B.lN];
  for(let round=0;round<4&&merged.length<8;round++) {
    for(const pool of order) {
      if(merged.length>=8) break;
      let pick=pool.find(x=>!seen.has(x.m.ticker)&&!usedCats.has(x.m.category));
      if(!pick) pick=pool.find(x=>!seen.has(x.m.ticker));
      if(!pick) continue;
      seen.add(pick.m.ticker); usedCats.add(pick.m.category); merged.push(pick);
    }
  }
  STATE._approved=merged;
  const yN=merged.filter(x=>x.a.side==='YES').length,nN=merged.filter(x=>x.a.side==='NO').length;
  log('Nova',`${merged.length} diverse picks — YES:${yN} NO:${nN} · cats: ${[...usedCats].join(', ')}`);
}

/* ── AXEL: Kelly sizing + balance ── */
async function phaseAxel() {
  const dep=STATE.positions.reduce((s,p)=>s+p.size,0);
  const expPct=(dep/STATE.startCash*100).toFixed(0);
  log('Axel',`Exposure: ${expPct}% (cap 55%) · Cash: $${STATE.cash.toFixed(2)} · Kelly¼ active`);
  const eligible=(STATE._approved||[]).filter(x=>x.a.conf==='high'||x.a.conf==='med');
  if(parseFloat(expPct)>=55) {
    log('Axel','Exposure cap — holding cash','lt-warn');
    STATE._toPlace=[]; return;
  }
  const balanced=[],counts={short:0,long:0,YES:0,NO:0};
  for(const x of eligible) {
    if(balanced.length>=4) break;
    if(counts[x.termType]>=2||counts[x.a.side]>=2) continue;
    const kSize=kellySize(x.a.impliedProb,STATE.cash,x.a.conf,x.a.score);
    const winP=Math.min(x.a.impliedProb+edgeEstimate(x.a.conf,x.a.score),0.96);
    const profitW=((kSize)*(1/x.a.impliedProb-1)).toFixed(2);
    x._kSize=kSize;
    log('Axel',
      `PRE-TRADE: ${x.a.side} "${x.m.title.substring(0,28)}" · $${kSize.toFixed(2)} · `+
      `win ${(winP*100).toFixed(0)}% · profit if win: +$${profitW}`,'lt-kelly');
    counts[x.termType]++; counts[x.a.side]++; balanced.push(x);
  }
  STATE._toPlace=balanced;
  log('Axel',`Approved ${balanced.length} — YES:${counts.YES} NO:${counts.NO} Short:${counts.short} Long:${counts.long}`);
}

/* ── ZARA: Place REAL orders on Kalshi demo ── */
async function phaseZara() {
  if(!STATE._toPlace?.length) {
    log('Zara','Nothing to execute this cycle');
    return;
  }
  log('Zara',`Placing ${STATE._toPlace.length} REAL paper order(s) on Kalshi demo`);
  for(const {m,a,termType,_kSize} of STATE._toPlace) {
    if(!STATE.running) break;
    const size=_kSize||kellySize(a.impliedProb,STATE.cash,a.conf,a.score);
    if(size<1||STATE.cash<size+2) { log('Zara','Skip '+m.ticker+' — low cash','lt-warn'); continue; }
    /* Place real order on Kalshi demo */
    const orderBody={
      ticker:   m.ticker,
      side:     a.side.toLowerCase(),
      action:   'buy',
      count:    Math.floor(size/a.impliedProb), /* contracts = dollars / price */
      type:     'market',
      client_order_id: `NPC-${Date.now()}-${Math.random().toString(36).substr(2,6)}`
    };
    try {
      const r=await kalshiRequest('POST','/orders',orderBody);
      if(r.status===200||r.status===201) {
        log('Zara',`✅ REAL ORDER PLACED: ${a.side} ${m.ticker} · $${size.toFixed(2)} @ ${(a.impliedProb*100).toFixed(0)}¢`,'lt-trade');
      } else {
        log('Zara',`Order rejected (${r.status}): ${JSON.stringify(r.body).substring(0,80)}`,'lt-warn');
      }
    } catch(e) {
      log('Zara','Order error: '+e.message,'lt-warn');
    }
    STATE.cash=parseFloat((STATE.cash-size).toFixed(2));
    const ev=(a.impliedProb*(1/a.impliedProb-1)-(1-a.impliedProb));
    const trade={
      id:Date.now()+Math.random(),
      ticker:m.ticker,market:m.title||m.ticker,category:m.category||'Unknown',
      agent:'Zara',side:a.side,
      entryPrice:a.impliedProb,currentPrice:a.impliedProb,
      size,pnl:0,status:'open',
      openedAt:ts(),closedAt:null,ticksOpen:0,
      conf:a.conf,shortTerm:termType==='short',term:termType,
      expires:m.close_time||m.expiration_time||null,
      reasoning:a.reasoning||'',
      entryScore:a.score,
      payoutMult:(1/a.impliedProb).toFixed(2),
      expectedReturn:(ev*100).toFixed(1),
      kellyFrac:kellyFraction(Math.min(a.impliedProb+edgeEstimate(a.conf,a.score),0.97),a.impliedProb).toFixed(1)
    };
    STATE.trades.push(trade);
    STATE.positions.push({...trade});
    await sleep(200);
  }
}

/* ── KNOX: Real settlement checking ── */
async function phaseKnox() {
  if(!STATE.positions.length) {
    log('Knox','No open positions to monitor');
    return;
  }
  log('Knox',`Checking ${STATE.positions.length} REAL position(s) on Kalshi demo`);
  for(const pos of STATE.positions) pos.ticksOpen=(pos.ticksOpen||0)+1;
  const toClose=[];
  /* Get real settled markets from Kalshi */
  for(const pos of STATE.positions) {
    try {
      const r=await kalshiRequest('GET',`/markets/${pos.ticker}`);
      if(r.status===200 && r.body.market) {
        const mkt=r.body.market;
        /* Update mark price */
        if(mkt.yes_bid) {
          pos.currentPrice=parseFloat(mkt.yes_bid);
          const mt=STATE.trades.find(t=>t.id===pos.id);
          if(mt) mt.currentPrice=pos.currentPrice;
        }
        if(mkt.status==='settled' && mkt.result) {
          /* REAL SETTLEMENT */
          const won=(pos.side==='YES'&&mkt.result==='yes')||(pos.side==='NO'&&mkt.result==='no');
          const payout=won?parseFloat((pos.size/pos.entryPrice).toFixed(2)):0;
          const pnl=parseFloat((payout-pos.size).toFixed(2));
          toClose.push({pos,won,pnl,result:mkt.result,real:true});
          log('Knox',`[REAL SETTLE] ${pos.ticker} → ${mkt.result.toUpperCase()} ${won?'WIN ✓':'LOSS ✗'}`,'lt-info');
        } else {
          log('Knox',`${pos.ticker} [${pos.term}] still open · mark ${(pos.currentPrice*100).toFixed(0)}¢ · ~${timeLeft({close_time:pos.expires})} left`);
        }
      }
    } catch(e) { log('Knox','Cannot reach '+pos.ticker+': '+e.message,'lt-warn'); }
    await sleep(150);
  }
  /* Close settled positions */
  for(const {pos,won,pnl,result,real} of toClose) {
    STATE.cash=parseFloat((STATE.cash+pos.size+pnl).toFixed(2));
    const mt=STATE.trades.find(t=>t.id===pos.id);
    if(mt) { mt.pnl=pnl; mt.status=won?'win':'loss'; mt.closedAt=ts(); learnRecord(mt); }
    STATE.positions=STATE.positions.filter(p=>p.id!==pos.id);
    log('Knox',
      `${won?'✓ WIN':'✗ LOSS'} [${pos.term}][${pos.category}] `+
      `"${pos.market.substring(0,30)}" → ${pnl>=0?'+':''}$${Math.abs(pnl).toFixed(2)}`+
      `${real?' (REAL KALSHI SETTLEMENT)':''}`,
      won?'lt-trade':'lt-err');
  }
  if(!toClose.length) log('Knox',`All ${STATE.positions.length} positions waiting on real Kalshi resolution`);
}

/* ── Main tick loop ── */
async function runTick() {
  if(!STATE.running||STATE.paused) return;
  STATE.tick++;
  log('System',`═══ TICK #${STATE.tick} — North Pointe Capital ═══`,'lt-sys');
  /* Refresh data every few ticks */
  if(STATE.tick%5===0) await refreshPrices();
  if(STATE.tick%8===0) await refreshNews();
  /* Ensure login */
  await kalshiLogin();
  /* Run pipeline */
  await phaseRex();       await sleep(500);
  await phaseFlashSage(); await sleep(500);
  await phaseNova();      await sleep(400);
  await phaseAxel();      await sleep(350);
  await phaseZara();      await sleep(350);
  await phaseKnox();
  log('System',`Portfolio: $${(STATE.cash+STATE.positions.reduce((s,p)=>s+p.size,0)).toFixed(2)} · Trades: ${STATE.trades.length} · Positions: ${STATE.positions.length}`,'lt-sys');
}

/* ── Scheduler ── */
let tickTimer=null;
function startScheduler() {
  if(tickTimer) clearInterval(tickTimer);
  tickTimer=setInterval(async()=>{
    try { await runTick(); }
    catch(e) { log('System','Tick error: '+e.message,'lt-err'); }
  }, TICK_MS);
  log('System',`Scheduler started — ticking every ${TICK_MS/1000}s`,'lt-sys');
}
function stopScheduler() {
  if(tickTimer) { clearInterval(tickTimer); tickTimer=null; }
}

/* ══════════════════════════════════════════════════════════
   HTTP SERVER — serves the dashboard API
   Your browser dashboard calls these endpoints
   ══════════════════════════════════════════════════════════ */
const server = http.createServer(async (req, res) => {
  /* CORS headers so browser can call this server */
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if(req.method==='OPTIONS') { res.writeHead(200); res.end(); return; }

  const parsed  = url.parse(req.url, true);
  const path    = parsed.pathname;
  const json    = d => { res.setHeader('Content-Type','application/json'); res.writeHead(200); res.end(JSON.stringify(d)); };
  const notFound= () => { res.writeHead(404); res.end('Not found'); };

  /* ── Dashboard UI ── */
  if(path==='/' || path==='/dashboard') {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    const fs = require('fs');
    const path2 = require('path');
    const htmlPath = path2.join(__dirname, 'dashboard.html');
    if(fs.existsSync(htmlPath)) {
      res.end(fs.readFileSync(htmlPath, 'utf8'));
    } else {
      res.end('<html><body style="background:#0b0d12;color:#22c55e;font-family:monospace;padding:40px"><h1>North Pointe Capital</h1><p>Dashboard file not found. Upload dashboard.html to Railway.</p><p><a href="/health" style="color:#60a5fa">/health</a></p></body></html>');
    }
    return;
  }

  /* ── Health check ── */
  if(path==='/health') {
    return json({
      status: 'North Pointe Capital — Trading Server Online',
      running: STATE.running,
      paused:  STATE.paused,
      tick:    STATE.tick,
      portfolio: parseFloat((STATE.cash+STATE.positions.reduce((s,p)=>s+p.size,0)).toFixed(2)),
      cash:    STATE.cash,
      positions: STATE.positions.length,
      trades:  STATE.trades.length,
      uptime:  process.uptime().toFixed(0)+'s'
    });
  }

  /* ── Full state for dashboard ── */
  if(path==='/state') {
    return json({
      running:  STATE.running,
      paused:   STATE.paused,
      cash:     STATE.cash,
      startCash:STATE.startCash,
      trades:   STATE.trades.slice(-200),
      positions:STATE.positions,
      log:      STATE.log.slice(0,100),
      markets:  STATE.markets.slice(0,50),
      prices:   STATE.prices,
      tick:     STATE.tick,
      totalScanned: STATE.totalScanned,
      learnTotal:   STATE.learnTotal,
      learnData:    STATE.learnData,
    });
  }

  /* ── Controls ── */
  if(path==='/start') {
    STATE.running=true; STATE.paused=false;
    startScheduler();
    /* Run first tick immediately */
    runTick().catch(e=>log('System','First tick error: '+e.message,'lt-err'));
    log('System','▶ Trading STARTED via dashboard','lt-sys');
    return json({ok:true, message:'Trading started'});
  }
  if(path==='/pause') {
    STATE.paused=true; STATE.running=false;
    stopScheduler();
    log('System','⏸ Trading PAUSED via dashboard','lt-warn');
    return json({ok:true, message:'Trading paused'});
  }
  if(path==='/stop') {
    STATE.running=false; STATE.paused=false;
    stopScheduler();
    const pnl=STATE.trades.filter(t=>t.status!=='open').reduce((s,t)=>s+t.pnl,0);
    log('System',`⏹ Trading STOPPED — P&L: ${pnl>=0?'+':''}$${Math.abs(pnl).toFixed(2)}`,'lt-warn');
    return json({ok:true, message:'Trading stopped', pnl});
  }

  /* ── Markets (live from Kalshi) ── */
  if(path==='/markets') {
    return json({markets: STATE.markets.slice(0,50)});
  }

  /* ── Prices (live from Finnhub) ── */
  if(path==='/prices') {
    return json({prices: STATE.prices});
  }

  /* ── News ── */
  if(path==='/news') {
    return json({headlines: STATE.headlines});
  }

  /* ── Proxy for browser → Kalshi API calls ── */
  if(path.startsWith('/proxy/kalshi')) {
    const kalshiPath = path.replace('/proxy/kalshi','');
    try {
      const r = await kalshiRequest('GET', kalshiPath);
      return json(r.body);
    } catch(e) {
      res.writeHead(500); res.end(e.message); return;
    }
  }

  /* ── Proxy for browser → Finnhub ── */
  if(path.startsWith('/proxy/finnhub')) {
    const sym = parsed.query.symbol||'';
    try {
      const r = await request({
        hostname:'finnhub.io',
        path:`/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${FH_KEY}`,
        method:'GET', headers:{}
      });
      return json(r.body);
    } catch(e) {
      res.writeHead(500); res.end(e.message); return;
    }
  }

  notFound();
});

/* ── Boot ── */
server.listen(PORT, () => {
  console.log(`\n✅ North Pointe Capital server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   State:  http://localhost:${PORT}/state`);
  console.log(`   Start:  http://localhost:${PORT}/start`);
  console.log('\n   Initializing data feeds...\n');
  /* Boot sequence */
  Promise.all([refreshPrices(), refreshNews(), kalshiLogin()])
    .then(() => {
      console.log('   ✅ Data feeds initialized');
      console.log('   Ready — use /start to begin trading\n');
    })
    .catch(e => console.log('   Boot error:', e.message));
});

server.on('error', e => {
  console.error('Server error:', e.message);
  process.exit(1);
});

process.on('uncaughtException',  e => console.error('Uncaught:', e.message));
process.on('unhandledRejection', e => console.error('Unhandled:', e));
