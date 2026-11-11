/**
 * 押注商店（B 键开关）
 *   每局固定押 100 在红队 / 蓝队胜；彩池制赔率 = 总池 ÷ 该队池，随投注比例实时变化。
 *   押中 → 拿回 下注额 × 赔率；押错 → 输掉下注额。押同一队再按一次 = 取消退本。
 */
export class BetShop {
  /** @param onBet (team:'A'|'B') => void  由外部发到服务端 */
  constructor(onBet) {
    this.onBet = onBet;
    this.open = false;
    this.state = {
      pool: { A: 0, B: 0 }, odds: { A: 0, B: 0 }, amount: 100, round: 1,
      amb: { pool: { big: 0, small: 0 }, odds: { big: 0, small: 0 }, count: 0, line: 0.5 },
    };
    this.me = { coins: 0, betTeam: null, betAmt: 0, ambBet: null, ambAmt: 0 };

    const el = document.createElement('div');
    el.id = 'shop';
    el.hidden = true;
    el.innerHTML = `
      <div class="shCard">
        <header class="shHead">
          <b>押注商店</b>
          <span class="shRound">第 1 局</span>
          <span class="shCoins">🪙 <b>0</b></span>
          <button type="button" class="shClose" aria-label="关闭">✕</button>
        </header>
        <p class="shTip">每局固定押 <b>100</b> · 押中按彩池比例结算（押的人越少赔率越高）· 押同一队再按一次取消</p>
        <div class="shRows">
          <div class="shRow tA" data-team="A">
            <i class="shDot"></i>
            <div class="shName"><b>红队</b><em>TEAM RED</em></div>
            <div class="shOdds"><b class="o">—</b><em>赔率</em></div>
            <div class="shPool"><b class="p">0</b><em>彩池</em></div>
            <button type="button" class="shBet">押 100</button>
          </div>
          <div class="shRow tB" data-team="B">
            <i class="shDot"></i>
            <div class="shName"><b>蓝队</b><em>TEAM BLUE</em></div>
            <div class="shOdds"><b class="o">—</b><em>赔率</em></div>
            <div class="shPool"><b class="p">0</b><em>彩池</em></div>
            <button type="button" class="shBet">押 100</button>
          </div>
        </div>
        <p class="shSub">救护车进场盘 · 押本局出车次数（全场累计，不分队伍）</p>
        <div class="shRows">
          <div class="shRow ambRow" data-amb="big">
            <i class="shDot amb"></i>
            <div class="shName"><b>大 0.5</b><em>本局出车 ≥ 1 次</em></div>
            <div class="shOdds"><b class="o">—</b><em>赔率</em></div>
            <div class="shPool"><b class="p">0</b><em>彩池</em></div>
            <button type="button" class="shBet">押 100</button>
          </div>
          <div class="shRow ambRow" data-amb="small">
            <i class="shDot amb"></i>
            <div class="shName"><b>小 0.5</b><em>本局没出过车</em></div>
            <div class="shOdds"><b class="o">—</b><em>赔率</em></div>
            <div class="shPool"><b class="p">0</b><em>彩池</em></div>
            <button type="button" class="shBet">押 100</button>
          </div>
        </div>
        <div class="shMine">我的押注：<b class="mine">未押</b></div>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    this.card = el.querySelector('.shCard');
    this.roundEl = el.querySelector('.shRound');
    this.coinsEl = el.querySelector('.shCoins b');
    this.mineEl = el.querySelector('.mine');
    this.rows = [...el.querySelectorAll('.shRow')].map((r) => ({
      team: r.dataset.team, root: r,
      odds: r.querySelector('.o'), pool: r.querySelector('.p'),
      btn: r.querySelector('.shBet'),
    }));
    this.rows.forEach((r) => r.btn.addEventListener('click', () => this.onBet && this.onBet({ team: r.team })));
    this.ambRows = [...el.querySelectorAll('.shRow.ambRow')].map((r) => ({
      side: r.dataset.amb, root: r,
      odds: r.querySelector('.o'), pool: r.querySelector('.p'),
      btn: r.querySelector('.shBet'),
    }));
    this.ambRows.forEach((r) => r.btn.addEventListener('click', () => this.onBet && this.onBet({ type: 'amb', side: r.side })));
    el.querySelector('.shClose').addEventListener('click', () => this.setOpen(false));
    // 点卡片外面也关
    el.addEventListener('click', (e) => { if (e.target === el) this.setOpen(false); });

    // 结算飘字
    this.toastEl = document.createElement('div');
    this.toastEl.id = 'betToast';
    this.toastEl.hidden = true;
    document.body.appendChild(this.toastEl);
    this._toastT = 0;
  }

  setOpen(v) {
    this.open = !!v;
    this.el.hidden = !this.open;
    if (this.open) {
      // 打开商店 → 退出鼠标锁定，让鼠标能点按钮
      try { document.exitPointerLock && document.exitPointerLock(); } catch (e) {}
    }
    this.refresh();
  }
  toggle() { this.setOpen(!this.open); }

  /** 服务端 betUpdate */
  update(state) {
    if (!state) return;
    this.state = Object.assign(this.state, state);
    this.refresh();
  }

  /** 每帧从自己的 player state 同步金币 / 我的押注 */
  setMe(coins, betTeam, betAmt, ambBet, ambAmt) {
    const m = this.me;
    if (coins === m.coins && betTeam === m.betTeam && betAmt === m.betAmt
        && ambBet === m.ambBet && ambAmt === m.ambAmt) return;
    this.me = { coins: coins || 0, betTeam: betTeam || null, betAmt: betAmt || 0, ambBet: ambBet || null, ambAmt: ambAmt || 0 };
    this.refresh();
  }

  refresh() {
    const s = this.state;
    const amt = s.amount || 100;
    this.roundEl.textContent = '第 ' + (s.round || 1) + ' 局';
    this.coinsEl.textContent = this.me.coins;
    for (const r of this.rows) {
      const o = s.odds[r.team] || 0;
      r.odds.textContent = o > 0 ? '×' + o.toFixed(2) : '—';
      r.pool.textContent = (s.pool[r.team] || 0);
      const mine = this.me.betTeam === r.team;
      r.root.classList.toggle('mine', mine);
      r.btn.textContent = mine ? '取消' : ('押 ' + amt);
      r.btn.disabled = !mine && this.me.coins < amt;
    }
    const amb = s.amb || { pool: {}, odds: {} };
    for (const r of this.ambRows) {
      const o = (amb.odds || {})[r.side] || 0;
      r.odds.textContent = o > 0 ? '×' + o.toFixed(2) : '—';
      r.pool.textContent = ((amb.pool || {})[r.side] || 0);
      const mine = this.me.ambBet === r.side;
      r.root.classList.toggle('mine', mine);
      r.btn.textContent = mine ? '取消' : ('押 ' + amt);
      r.btn.disabled = !mine && this.me.coins < amt;
    }
    const parts = [];
    if (this.me.betTeam) parts.push((this.me.betTeam === 'A' ? '红队' : '蓝队') + ' ' + this.me.betAmt);
    if (this.me.ambBet) parts.push('救护车' + (this.me.ambBet === 'big' ? '大' : '小') + '0.5 ' + this.me.ambAmt);
    this.mineEl.textContent = parts.length ? parts.join(' · ') : '未押';
  }

  /** 服务端 betSettle */
  settle(ev) {
    if (!ev) return;
    const lines = ev.lines || [];
    if (!lines.length) return;
    this.toast(lines.join('　'));
  }

  toast(text) {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    this._toastT = 6;
  }

  tick(dt) {
    if (this._toastT > 0) {
      this._toastT -= dt;
      if (this._toastT <= 0) this.toastEl.hidden = true;
    }
  }
}
