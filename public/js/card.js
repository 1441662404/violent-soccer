/* ============================================================
 *  属性卡（FUT 风格）+ 卡牌物品栏
 *  - 踢球模式下按数字键 1~9 使用对应卡槽的卡
 *  - 使用后播放"卡牌飞出 + 光效"动画，HUD 显示加成倒计时
 *  - 卡面用 CSS + SVG 画（不依赖任何图片素材）
 * ============================================================ */
const CARD_META = {
  striker: {
    name: '前锋', rating: 91, pos: 'ST', league: 'PRO LEAGUE', club: 'Capital FC',
    stats: [['PAC', 97], ['SHO', 91], ['PAS', 82], ['DRI', 92], ['DEF', 38], ['PHY', 76]],
    alt: ['LM', 'LW'], wr: 'R', skill: '5★4', price: '4,159,450',
    desc: '使用后最高跑速 +10%，持续 10 秒',
  },
};

/** 造一张 FUT 风格卡（DOM） */
function buildCard(id) {
  const m = CARD_META[id] || CARD_META.striker;
  const el = document.createElement('div');
  el.className = 'futCard';
  el.innerHTML = `
    <div class="futGlow"></div>
    <div class="futTop">
      <div class="futRating"><b>${m.rating}</b><span>${m.pos}</span></div>
      <div class="futLeague">${m.league}</div>
      <div class="futAlts">${m.alt.map(a => `<i>${a}</i>`).join('')}</div>
    </div>
    <div class="futFig">
      <svg viewBox="0 0 100 120" preserveAspectRatio="xMidYMax meet">
        <defs>
          <linearGradient id="figGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#dfe7f2"/><stop offset="1" stop-color="#8fa2bb"/>
          </linearGradient>
        </defs>
        <circle cx="50" cy="26" r="15" fill="url(#figGrad)"/>
        <path d="M22 118 C22 72 34 46 50 46 C66 46 78 72 78 118 Z" fill="url(#figGrad)"/>
        <path d="M50 46 L62 96 L50 118 L38 96 Z" fill="rgba(10,16,24,.25)"/>
      </svg>
    </div>
    <div class="futBottom">
      <div class="futName">${m.name}</div>
      <div class="futStats">${m.stats.map(([k, v]) => `<span><i>${k}</i><b>${v}</b></span>`).join('')}</div>
      <div class="futFoot"><span class="futClub">${m.club}</span><span class="futPrice">${m.price}</span></div>
    </div>
    <div class="futBadges"><i>${m.wr}</i><i>${m.skill}</i></div>`;
  return el;
}

/** 攻击模式的技能卡内容（图标 / 名称 / 说明） */
const SKILL_CARDS = {
  flyKick:   { name: '飞踢', icon: '🦵', hint: '短 CD' },
  hurricane: { name: '螺旋踢', icon: '🌀', hint: '长 CD' },
  spin:      { name: '马赛回旋', icon: '🎩', hint: '花式' },
};

export class CardBar {
  /** onUse(slot) 由外部提供（发到服务端） */
  constructor(onUse) {
    this.onUse = onUse;
    this.slots = [];
    this.mode = 'soccer';                 // 'soccer' 显示属性卡 · 'attack' 显示技能卡
    this.el = document.createElement('div');
    this.el.id = 'cardBar';
    document.body.appendChild(this.el);
    this.boostEl = document.createElement('div');
    this.boostEl.id = 'boostHud';
    this.boostEl.hidden = true;
    document.body.appendChild(this.boostEl);
    this._lastBoost = 0;
    this._skl = [];                       // 当前技能卡 DOM（攻击模式）
    this._lastKey = '';                   // 上次渲染的模式标识
    this._domMode = '';                   // 当前 DOM 实际渲染的是哪套卡（''|'soccer'|'attack'）
  }

  /** 攻击模式：渲染技能卡（飞踢 / 螺旋踢），无限使用、各自冷却 */
  _renderSkills(skills) {
    const key = 'attack:' + skills.map(s => s.key).join(',');
    // 已是技能卡且内容一致，且 DOM 确实是技能卡 → 不重建
    if (this._lastKey === key && this._domMode === 'attack') return;
    this._lastKey = key;
    this._domMode = 'attack';
    this.slots = [];                                  // 清掉属性卡引用，避免误判
    this.el.innerHTML = '';
    this._skl = skills.map((s, i) => {
      const meta = SKILL_CARDS[s.key] || {};
      const name = s.name || meta.name || s.key;
      const icon = s.icon || meta.icon || '⚡';
      const hint = s.hint || meta.hint || '';
      const slot = document.createElement('div');
      slot.className = 'cardSlot skillSlot';
      slot.dataset.slot = i;
      slot.dataset.key = s.key;
      slot.innerHTML = `
        <div class="skillCard">
          <div class="skillIcon">${icon}</div>
          <div class="skillName">${name}</div>
          <div class="skillHint">${hint}</div>
        </div>
        <div class="skillCdMask"><b></b></div>`;
      const kb = document.createElement('b');
      kb.className = 'cardKey';
      kb.textContent = String(i + 1);
      slot.appendChild(kb);
      slot.addEventListener('click', () => this.use(i));
      this.el.appendChild(slot);
      return { slot, key: s.key, mask: slot.querySelector('.skillCdMask'), maskTxt: slot.querySelector('.skillCdMask b') };
    });
  }

  /** 每帧：更新技能冷却遮罩（0 = 可用）
   *  @param cd      各技能剩余冷却
   *  @param noBall  自己**没持球** → 置灰"需持球"的花式卡（马赛回旋做不了） */
  updateSkills(cd, noBall) {
    if (!this._skl.length || !cd) return;
    for (const s of this._skl) {
      const t = cd[s.key] || 0;
      const need = !!s.needBall && !!noBall;
      if (s.slot.classList.contains('needBall') !== need) s.slot.classList.toggle('needBall', need);
      if (t > 0.02) {
        s.slot.classList.add('cooling');
        s.mask.style.display = 'flex';
        s.maskTxt.textContent = t.toFixed(1);
      } else {
        s.slot.classList.remove('cooling');
        s.mask.style.display = 'none';
      }
    }
  }

  /** 踢球模式的**技能卡**（马赛回旋等花式动作）：插在属性卡前面，各自带 CD 遮罩 */
  _renderSoccerSkills(skills) {
    this._soccerList = skills;
    const key = 'soccer:' + skills.map((s) => s.key).join(',');
    if (this._soccerKey === key && this.el.querySelector('.skillSlot')) return;
    this._soccerKey = key;
    this.el.querySelectorAll('.cardSlot.skillSlot').forEach((n) => n.remove());
    this._skl = [];
    const frag = document.createDocumentFragment();
    skills.forEach((s, i) => {
      const meta = SKILL_CARDS[s.key] || {};
      const slot = document.createElement('div');
      slot.className = 'cardSlot skillSlot';
      slot.dataset.slot = i;
      slot.dataset.key = s.key;
      slot.innerHTML = `
        <div class="skillCard">
          <div class="skillIcon">${meta.icon || '⚡'}</div>
          <div class="skillName">${meta.name || s.key}</div>
          <div class="cardKey">${i + 1}</div>
          <div class="skillNeed">需持球</div>
          <div class="skillCdMask" style="display:none"><b>0</b></div>
        </div>`;
      slot.addEventListener('click', () => { this.onUse && this.onUse(i); });
      frag.appendChild(slot);
      this._skl.push({
        slot, key: s.key,
        needBall: !!s.needBall,          // 没持球时置灰（马赛回旋）
        mask: slot.querySelector('.skillCdMask'),
        maskTxt: slot.querySelector('.skillCdMask b'),
      });
    });
    this.el.insertBefore(frag, this.el.firstChild);
    this._skillCount = skills.length;
  }

  /** 按服务端下发的 cards 同步物品栏 */
  sync(cards) {
    if (!cards) return;
    // 重建条件：数量变化，或当前 DOM 不是属性卡（从攻击模式切回来时必须重建，
    // 否则 DOM 里残留技能卡 → 就是"踢球模式卡牌和攻击模式冲突"的表现）
    if (this._domMode !== 'soccer' || this.slots.length !== cards.length) {
      this.el.innerHTML = '';
      this._lastKey = '';
      this._domMode = 'soccer';
      this._skl = [];
      this.slots = cards.map((c, i) => {
        const slot = document.createElement('div');
        slot.className = 'cardSlot';
        slot.dataset.slot = i;
        const card = buildCard(c.id);
        slot.appendChild(card);
        const key = document.createElement('b');
        key.className = 'cardKey';
        key.textContent = String(i + 1);
        slot.appendChild(key);
        slot.addEventListener('click', () => this.use(i + (this._skillCount || 0)));
        this.el.appendChild(slot);
        return { slot, card, id: c.id };
      });
      /* ★ 重建会清空整条 → 把踢球模式的技能卡补回最前面 */
      this._soccerKey = '';
      if (this._soccerList && this._soccerList.length) this._renderSoccerSkills(this._soccerList);
    }
    cards.forEach((c, i) => {
      const s = this.slots[i];
      if (!s) return;
      s.slot.classList.toggle('spent', !!c.spent);
    });
  }

  use(i) {
    if (this.mode === 'attack') {                    // 攻击模式：点击 = 放技能（无限用，冷却自己管）
      const s = this._skl[i];
      if (s && !s.slot.classList.contains('cooling')) this.onUse && this.onUse(i);
      return;
    }
    const s = this.slots[i];
    if (!s || s.slot.classList.contains('spent')) return;
    this.onUse && this.onUse(i);
  }

  /** 切换卡牌条模式：踢球=属性卡；攻击=技能卡；跳舞=隐藏 */
  setMode(mode, skills) {
    const want = mode === 'attack' ? 'attack' : 'soccer';
    const hidden = mode === 'dance';
    this.el.style.display = hidden ? 'none' : 'flex';
    if (hidden) this.boostEl.hidden = true;
    if (want === 'attack') {
      this._skillCount = 0;
      this._soccerList = null;
      this._soccerKey = '';
      this._renderSkills(skills && skills.length ? skills : [{ key: 'flyKick' }, { key: 'hurricane' }]);
    } else if (skills && skills.length) {
      this._renderSoccerSkills(skills);       // 踢球模式：花式卡跟在属性卡前面
    } else {
      this._skillCount = 0;
      this._soccerList = null;
      this._soccerKey = '';
      this.el.querySelectorAll('.cardSlot.skillSlot').forEach((n) => n.remove());
      this._skl = [];
    }
    this.mode = want;
  }

  /** 使用成功的动画：卡牌飞向中间放大 + 光效 */
  playUseAnim(i) {
    const s = this.slots[i];
    if (!s) return;
    s.slot.classList.add('using');
    const fly = buildCard(s.id || 'striker');
    fly.classList.add('futFly');
    document.body.appendChild(fly);
    setTimeout(() => fly.remove(), 1300);
    setTimeout(() => s.slot.classList.remove('using'), 900);
    this.boostEl.hidden = false;
    this.boostEl.classList.add('flash');
    setTimeout(() => this.boostEl.classList.remove('flash'), 900);
  }

  /** 每帧：显示加速倒计时 */
  update(boost) {
    if (typeof boost !== 'number') return;
    if (boost > 0) {
      this.boostEl.hidden = false;
      this.boostEl.classList.add('active');
      this.boostEl.innerHTML = `⚡ 最快速度 +10% <b>${boost.toFixed(1)}s</b>`;
    } else if (this._lastBoost > 0) {
      this.boostEl.classList.remove('active');
      this.boostEl.hidden = true;
    }
    this._lastBoost = boost;
  }
}
