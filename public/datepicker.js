/* exported DateRangePicker */
// A small calendar pop-up for picking a date range, no dependencies.
//
//   const picker = new DateRangePicker(buttonEl, { onChange: (range) => ... });
//   picker.setRunDates(['2026-10-13', ...]);   // days with runs get a dot
//   picker.range  -> { from: 'YYYY-MM-DD' | null, to: 'YYYY-MM-DD' | null }
//
// No dates chosen = all time. The choice is kept for this browser tab only
// (sessionStorage), so moving between the map and One start keeps it, while
// a fresh visit starts at "All time".

const DRP_KEY = 'rm.range';

class DateRangePicker {
  constructor(button, { onChange } = {}) {
    this.button = button;
    this.onChange = onChange || (() => {});
    this.runDays = new Set();
    this.minDay = null;
    this.maxDay = todayStr();
    this.range = { from: null, to: null, preset: 'all' };
    this.draft = null; // selection in progress while the pop-up is open
    this.hoverDay = null;

    try {
      const saved = JSON.parse(sessionStorage.getItem(DRP_KEY) || 'null');
      if (saved && (saved.preset || saved.from)) this.range = this.resolve(saved);
    } catch { /* ignore */ }

    this.pop = document.createElement('div');
    this.pop.className = 'drp hidden';
    this.pop.setAttribute('role', 'dialog');
    this.pop.setAttribute('aria-label', 'Choose dates');
    this.backdrop = document.createElement('div');
    this.backdrop.className = 'drp-backdrop hidden';
    document.body.append(this.backdrop, this.pop);

    button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('click', () => (this.isOpen() ? this.close() : this.open()));
    this.backdrop.addEventListener('click', () => this.close());
    document.addEventListener('mousedown', (e) => {
      if (this.isOpen() && !this.pop.contains(e.target) && !button.contains(e.target)) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (this.isOpen() && e.key === 'Escape') {
        e.stopPropagation();
        this.close();
        button.focus();
      }
    }, true);
    window.addEventListener('resize', () => this.isOpen() && this.position());
    this.updateButton();
  }

  // ---- public ------------------------------------------------------------

  setRunDates(days) {
    this.runDays = new Set(days.map((d) => d.slice(0, 10)));
    const sorted = [...this.runDays].sort();
    this.minDay = sorted[0] || null;
    // re-resolve relative presets now that we know which years exist
    this.range = this.resolve(this.range);
    this.updateButton();
  }

  // Does a run date ('YYYY-MM-DD...') fall in the current range?
  includes(date) {
    const d = date.slice(0, 10);
    const { from, to } = this.range;
    return (!from || d >= from) && (!to || d <= to);
  }

  isAllTime() {
    return !this.range.from && !this.range.to;
  }

  setRange(range, { silent = false } = {}) {
    this.range = this.resolve(range);
    try {
      if (this.isAllTime()) sessionStorage.removeItem(DRP_KEY);
      else sessionStorage.setItem(DRP_KEY, JSON.stringify(this.range.preset && !this.range.preset.startsWith('custom') ? { preset: this.range.preset } : this.range));
    } catch { /* ignore */ }
    this.updateButton();
    if (!silent) this.onChange(this.range);
  }

  // ---- presets -------------------------------------------------------------

  presets() {
    const t = todayStr();
    const list = [
      { id: 'all', label: 'All time' },
      { id: 'd7', label: 'Last 7 days', from: addDays(t, -6), to: t },
      { id: 'd30', label: 'Last 30 days', from: addDays(t, -29), to: t },
      { id: 'd90', label: 'Last 3 months', from: addMonths(t, -3), to: t },
      { id: 'd365', label: 'Last 12 months', from: addMonths(t, -12), to: t },
    ];
    const first = this.minDay ? Number(this.minDay.slice(0, 4)) : Number(t.slice(0, 4));
    for (let y = Number(t.slice(0, 4)); y >= first; y--) {
      list.push({ id: `y${y}`, label: String(y), from: `${y}-01-01`, to: `${y}-12-31`, year: true });
    }
    return list;
  }

  resolve(r) {
    if (!r || r.preset === 'all' || (!r.from && !r.to && !r.preset)) return { from: null, to: null, preset: 'all' };
    if (r.preset && r.preset !== 'custom') {
      const p = this.presets().find((x) => x.id === r.preset);
      if (p) return { from: p.from || null, to: p.to || null, preset: p.id };
      if (/^y\d{4}$/.test(r.preset)) {
        const y = r.preset.slice(1);
        return { from: `${y}-01-01`, to: `${y}-12-31`, preset: r.preset };
      }
    }
    return { from: r.from || null, to: r.to || null, preset: 'custom' };
  }

  label(r = this.range) {
    if (!r.from && !r.to) return 'All time';
    const p = this.presets().find((x) => x.id === r.preset);
    if (p) return p.label;
    if (r.from === r.to) return fmtDay(r.from, true);
    const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
    return `${fmtDay(r.from, !sameYear)} – ${fmtDay(r.to, true)}`;
  }

  updateButton() {
    const text = this.button.querySelector('.drp-label') || this.button;
    text.textContent = this.label();
    this.button.classList.toggle('is-filtered', !this.isAllTime());
    this.button.title = this.isAllTime() ? 'Choose dates' : `Showing ${this.label()}`;
  }

  // ---- pop-up ----------------------------------------------------------------

  isOpen() {
    return !this.pop.classList.contains('hidden');
  }

  open() {
    this.draft = { from: this.range.from, to: this.range.to };
    // show the month of the end of the range (or this month)
    const anchor = this.range.to || this.maxDay;
    this.viewMonth = monthStart(this.monthsShown() === 2 ? addMonths(anchor, -1) : anchor);
    this.render();
    this.pop.classList.remove('hidden');
    this.backdrop.classList.toggle('hidden', !this.isSheet());
    this.button.setAttribute('aria-expanded', 'true');
    this.position();
    (this.pop.querySelector('.drp-day.is-start') || this.pop.querySelector('.drp-presets button[aria-pressed="true"]') || this.pop.querySelector('button'))?.focus({ preventScroll: true });
  }

  close() {
    this.pop.classList.add('hidden');
    this.backdrop.classList.add('hidden');
    this.button.setAttribute('aria-expanded', 'false');
    this.draft = null;
  }

  isSheet() {
    return window.innerWidth <= 640;
  }

  monthsShown() {
    return window.innerWidth > 760 ? 2 : 1;
  }

  position() {
    if (this.isSheet()) {
      Object.assign(this.pop.style, { left: '', top: '', right: '' });
      this.pop.classList.add('sheet');
      return;
    }
    this.pop.classList.remove('sheet');
    const b = this.button.getBoundingClientRect();
    const w = this.pop.offsetWidth;
    let left = b.left;
    if (left + w > window.innerWidth - 12) left = Math.max(12, window.innerWidth - 12 - w);
    this.pop.style.left = `${left}px`;
    this.pop.style.top = `${b.bottom + 8}px`;
  }

  render() {
    const presets = this.presets();
    const activePreset = this.matchPreset(this.draft);
    const quick = presets.filter((p) => !p.year);
    const years = presets.filter((p) => p.year);

    const months = [];
    for (let i = 0; i < this.monthsShown(); i++) months.push(addMonths(this.viewMonth, i));

    this.pop.innerHTML = `
      <div class="drp-presets" aria-label="Quick ranges">
        ${quick.map((p) => presetBtn(p, activePreset)).join('')}
        ${years.length ? `<div class="drp-sep">Years</div>${years.map((p) => presetBtn(p, activePreset)).join('')}` : ''}
      </div>
      <div class="drp-main">
        <div class="drp-months">${months.map((m, i) => this.monthHtml(m, i, months.length)).join('')}</div>
        <div class="drp-foot">
          <div class="drp-summary">${this.summaryText()}</div>
          <div class="drp-actions">
            <button type="button" class="drp-btn" data-act="clear">Clear</button>
            <button type="button" class="drp-btn primary" data-act="apply" ${this.draftComplete() ? '' : 'disabled'}>Apply</button>
          </div>
        </div>
      </div>`;

    this.pop.querySelectorAll('[data-preset]').forEach((b) =>
      b.addEventListener('click', () => {
        this.setRange({ preset: b.dataset.preset });
        this.close();
      })
    );
    this.pop.querySelectorAll('[data-nav]').forEach((b) =>
      b.addEventListener('click', () => {
        this.viewMonth = addMonths(this.viewMonth, Number(b.dataset.nav));
        this.render();
      })
    );
    this.pop.querySelectorAll('select[data-jump]').forEach((s) =>
      s.addEventListener('change', () => {
        const idx = Number(s.dataset.jump);
        const m = this.pop.querySelector(`select[data-jump="${idx}"][data-part="m"]`).value;
        const y = this.pop.querySelector(`select[data-jump="${idx}"][data-part="y"]`).value;
        this.viewMonth = addMonths(`${y}-${m}-01`, -idx);
        this.render();
      })
    );
    const grid = this.pop.querySelector('.drp-months');
    grid.addEventListener('click', (e) => {
      const day = e.target.closest('.drp-day[data-day]');
      if (day && !day.disabled) this.pick(day.dataset.day);
    });
    grid.addEventListener('mouseover', (e) => {
      const day = e.target.closest('.drp-day[data-day]');
      if (!day || !this.draft || !this.draft.from || this.draft.to) return;
      if (this.hoverDay !== day.dataset.day) {
        this.hoverDay = day.dataset.day;
        this.paintRange();
      }
    });
    grid.addEventListener('keydown', (e) => this.onDayKey(e));
    this.pop.querySelector('[data-act="clear"]').addEventListener('click', () => {
      this.setRange({ preset: 'all' });
      this.close();
    });
    this.pop.querySelector('[data-act="apply"]').addEventListener('click', () => {
      if (!this.draftComplete()) return;
      const preset = this.matchPreset(this.draft);
      this.setRange(preset && preset !== 'all' ? { preset } : { ...this.draft, preset: 'custom' });
      this.close();
    });
    this.paintRange();
  }

  monthHtml(month, idx, count) {
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    const firstDow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday = 0
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const today = todayStr();
    const minYear = Math.min(this.minDay ? Number(this.minDay.slice(0, 4)) : y, y);
    const maxYear = Math.max(Number(today.slice(0, 4)), y);

    let cells = '';
    for (let i = 0; i < firstDow; i++) cells += '<span class="drp-blank"></span>';
    for (let d = 1; d <= days; d++) {
      const ds = `${month.slice(0, 8)}${String(d).padStart(2, '0')}`;
      const future = ds > today;
      const run = this.runDays.has(ds);
      cells += `<button type="button" class="drp-day${ds === today ? ' is-today' : ''}${run ? ' has-run' : ''}"
        data-day="${ds}" tabindex="-1" ${future ? 'disabled' : ''}
        aria-label="${fmtDay(ds, true)}${run ? ', has runs' : ''}">${d}</button>`;
    }

    const monthOpts = Array.from({ length: 12 }, (_, i) => {
      const mm = String(i + 1).padStart(2, '0');
      return `<option value="${mm}" ${i + 1 === m ? 'selected' : ''}>${monthName(i)}</option>`;
    }).join('');
    let yearOpts = '';
    for (let yy = maxYear; yy >= minYear; yy--) yearOpts += `<option ${yy === y ? 'selected' : ''}>${yy}</option>`;

    return `
      <div class="drp-month">
        <div class="drp-head">
          ${idx === 0 ? '<button type="button" class="drp-nav" data-nav="-1" aria-label="Previous month">‹</button>' : '<span class="drp-nav-space"></span>'}
          <div class="drp-jump">
            <select data-jump="${idx}" data-part="m" aria-label="Month">${monthOpts}</select>
            <select data-jump="${idx}" data-part="y" aria-label="Year">${yearOpts}</select>
          </div>
          ${idx === count - 1 ? '<button type="button" class="drp-nav" data-nav="1" aria-label="Next month">›</button>' : '<span class="drp-nav-space"></span>'}
        </div>
        <div class="drp-dow">${weekdayNames().map((w) => `<span>${w}</span>`).join('')}</div>
        <div class="drp-grid">${cells}</div>
      </div>`;
  }

  pick(day) {
    const d = this.draft || { from: null, to: null };
    if (!d.from || (d.from && d.to)) {
      this.draft = { from: day, to: null };
    } else {
      this.draft = day < d.from ? { from: day, to: d.from } : { from: d.from, to: day };
    }
    this.hoverDay = null;
    this.paintRange();
    this.pop.querySelector(`.drp-day[data-day="${day}"]`)?.focus({ preventScroll: true });
  }

  // Update range highlighting without rebuilding the calendar.
  paintRange() {
    const d = this.draft || {};
    let a = d.from;
    let b = d.to || (d.from && this.hoverDay ? this.hoverDay : d.from);
    if (a && b && b < a) [a, b] = [b, a];
    this.pop.querySelectorAll('.drp-day[data-day]').forEach((el) => {
      const ds = el.dataset.day;
      const inR = a && ds >= a && ds <= b;
      el.classList.toggle('in-range', !!inR);
      el.classList.toggle('is-start', ds === a);
      el.classList.toggle('is-end', ds === b);
      el.setAttribute('aria-pressed', String(!!inR));
    });
    const focusable = this.pop.querySelector('.drp-day.is-start') || this.pop.querySelector('.drp-day.is-today') || this.pop.querySelector('.drp-day:not([disabled])');
    this.pop.querySelectorAll('.drp-day').forEach((el) => (el.tabIndex = el === focusable ? 0 : -1));
    const summary = this.pop.querySelector('.drp-summary');
    if (summary) summary.innerHTML = this.summaryText();
    const apply = this.pop.querySelector('[data-act="apply"]');
    if (apply) apply.disabled = !this.draftComplete();
    const active = this.matchPreset(this.draft);
    this.pop.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === active)));
  }

  draftComplete() {
    return !!(this.draft && this.draft.from && this.draft.to);
  }

  summaryText() {
    const d = this.draft;
    if (!d || !d.from) return '<span class="muted">Pick a start day</span>';
    if (!d.to) return `${fmtDay(d.from, true)} → <span class="muted">pick an end day</span>`;
    const n = [...this.runDays].filter((x) => x >= d.from && x <= d.to).length;
    return `${this.label({ ...d, preset: 'custom' })} <span class="muted">· ${n} day${n === 1 ? '' : 's'} with runs</span>`;
  }

  matchPreset(r) {
    if (!r || (!r.from && !r.to)) return 'all';
    const p = this.presets().find((x) => x.from === r.from && x.to === r.to);
    return p ? p.id : null;
  }

  // Arrow keys move between days; Enter/Space picks.
  onDayKey(e) {
    const el = e.target.closest('.drp-day[data-day]');
    if (!el) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = addDays(el.dataset.day, step);
    let target = this.pop.querySelector(`.drp-day[data-day="${next}"]`);
    if (!target) {
      this.viewMonth = addMonths(this.viewMonth, step > 0 ? 1 : -1);
      this.render();
      target = this.pop.querySelector(`.drp-day[data-day="${next}"]`);
    }
    if (target && !target.disabled) {
      this.pop.querySelectorAll('.drp-day').forEach((d) => (d.tabIndex = -1));
      target.tabIndex = 0;
      target.focus();
      if (this.draft && this.draft.from && !this.draft.to) {
        this.hoverDay = next;
        this.paintRange();
      }
    }
  }
}

function presetBtn(p, active) {
  return `<button type="button" data-preset="${p.id}" aria-pressed="${p.id === active}">${p.label}</button>`;
}

// ---- date helpers (all on 'YYYY-MM-DD' strings, in UTC to avoid DST bugs) --

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function toUTC(s) {
  return new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))));
}
function fromUTC(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(s, n) {
  const d = toUTC(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUTC(d);
}
function addMonths(s, n) {
  const d = toUTC(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return fromUTC(d);
}
function monthStart(s) {
  return `${s.slice(0, 7)}-01`;
}
function monthName(i) {
  return new Date(Date.UTC(2024, i, 1)).toLocaleDateString(undefined, { month: 'long', timeZone: 'UTC' });
}
function weekdayNames() {
  // 2024-01-01 was a Monday
  return Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(undefined, { weekday: 'narrow', timeZone: 'UTC' })
  );
}
function fmtDay(s, withYear) {
  return toUTC(s).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC',
  });
}
