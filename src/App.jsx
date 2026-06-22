import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'

// ============================================================
//  HELPERS
// ============================================================
const genMonths = (sy, sm, ey, em, step = 1) => {
  const out = []
  let y = sy, m = sm
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${String(m).padStart(2, '0')}/${y}`)
    m += step
    while (m > 12) { m -= 12; y++ }
  }
  return out
}

const KINDER_MONTHS = genMonths(2026, 6, 2030, 6)
const ELEC_MONTHS   = genMonths(2026, 7, 2030, 11, 2)
const SAVING_MONTHS = genMonths(2026, 4, 2030, 4)

const fmt = (n) => {
  if (n === null || n === undefined || n === '') return '—'
  const rounded = Math.round(Number(n))
  return rounded.toLocaleString('he-IL') + ' ₪'
}

const fmtDec = (n, d = 2) =>
  n === null || n === undefined ? '—' : Number(n).toFixed(d)

const parseNum = (v) => {
  const n = parseFloat(String(v).replace(/,/g, ''))
  return isNaN(n) ? 0 : n
}

// Compute projected balance based on annual yield and days since balance was last set.
const computeLive = (acc, history) => {
  const stored = Number(acc.balance) || 0
  const yld = parseNum(acc.annualYield)
  if (!yld) return stored
  let anchor = null
  if (acc.balanceAsOf) anchor = new Date(acc.balanceAsOf)
  else if (history?.length) {
    const last = history
      .filter(h => h.accountId === acc.id)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0]
    if (last) anchor = new Date(last.date)
  }
  if (!anchor || isNaN(anchor.getTime())) return stored
  const days = Math.max(0, (Date.now() - anchor.getTime()) / 86400000)
  const dailyRate = (yld / 100) / 365
  return stored * Math.pow(1 + dailyRate, days)
}

// Standard amortization: monthly payment for fixed annual rate, principal, years.
const monthlyPayment = (P, annualRatePct, years) => {
  if (!P || !years) return 0
  const r = (Number(annualRatePct) || 0) / 100 / 12
  const n = years * 12
  if (r === 0) return P / n
  return P * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)
}

// =============================================================
//  CBS API — מדד תשומות הבנייה למגורים (Israeli CBS)
//  ─────────────────────────────────────────────────────────────
//  שולף את ערכי המדד מ-API הציבורי של הלמ"ס (api.cbs.gov.il).
//  אם הסדרה השתנתה — שנה את CBS_BUILDING_INDEX_ID בלבד.
//  סטטוס החיבור מוצג בלשונית "מדד תשומות בנייה" (חפש: API STATUS INDICATOR).
// =============================================================
const CBS_API_BASE          = 'https://api.cbs.gov.il/index/data/price'
const CBS_BUILDING_INDEX_ID = 120020   // ← מדד תשומות הבנייה למגורים (אם השתנה — עדכן כאן)
const CBS_FETCH_MONTHS      = 24       // ← כמה חודשים אחורה לשלוף (לפחות 12, ברירת מחדל 24)

const fetchCbsBuildingIndex = async () => {
  const now = new Date()
  const endY = now.getFullYear()
  const endM = now.getMonth() + 1
  const startMs = new Date(endY, endM - CBS_FETCH_MONTHS, 1)
  const startY = startMs.getFullYear()
  const startM = startMs.getMonth() + 1

  const url = `${CBS_API_BASE}?id=${CBS_BUILDING_INDEX_ID}&format=json` +
              `&startPeriod=${startY}-${String(startM).padStart(2, '0')}` +
              `&endPeriod=${endY}-${String(endM).padStart(2, '0')}` +
              `&download=false`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`שרת הלמ"ס החזיר ${res.status}`)
  const json = await res.json()

  const series = Array.isArray(json) ? json
              : json?.month || json?.data || json?.series || []

  return series
    .map(e => ({
      month: `${String(e.month ?? e.MM ?? '').padStart(2, '0')}/${e.year ?? e.YYYY ?? ''}`,
      value: parseFloat(e.value ?? e.currBase?.value ?? e.Value ?? 0),
    }))
    .filter(e => e.value > 0 && /^\d{2}\/\d{4}$/.test(e.month))
    .sort((a, b) => {
      const [am, ay] = a.month.split('/')
      const [bm, by] = b.month.split('/')
      return `${ay}-${am}`.localeCompare(`${by}-${bm}`)
    })
}

// Format date to DD/MM/YYYY. Accepts ISO timestamp, YYYY-MM-DD string, or Date.
const fmtDate = (val) => {
  if (!val) return '—'
  if (val instanceof Date) {
    return `${String(val.getDate()).padStart(2,'0')}/${String(val.getMonth()+1).padStart(2,'0')}/${val.getFullYear()}`
  }
  if (typeof val === 'string') {
    if (val.includes('T')) {
      const d = new Date(val)
      if (isNaN(d)) return val
      return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`
    }
    const iso = val.match(/^(\d{4})-(\d{2})-(\d{2})/)
    if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`
  }
  return val
}

// ============================================================
//  INITIAL DATA  (real values from Excel)
// ============================================================
const INIT = {
  accounts: [
    { id: 1, name: 'אוצר החייל - עובר ושב',       balance: 42988,  usage: 'כסף שוטף',             include: false, liquidity: 'נזיל',            notes: 'שמירה של לפחות 30,000 ₪ בעו״ש', auto: null },
    { id: 2, name: 'אוצר החייל - אלטשולר',        balance: 47833,  usage: 'הפקדות גן + חשמל',     include: true,  liquidity: 'נזיל',            notes: '', auto: null },
    { id: 3, name: 'אוצר החייל - ילין לפידות',    balance: 489356, usage: 'תשלום 2 ו-3',          include: true,  liquidity: 'נזיל',            notes: 'מיועדת להתאפס כמעט לגמרי בתשלום הקרוב', auto: null },
    { id: 4, name: 'אוצר החייל - מגדל',           balance: 90169,  usage: '',                      include: true,  liquidity: '',                notes: '', auto: null },
    { id: 5, name: 'בנק לאומי - פיקדון',          balance: 414860, usage: 'תשלומים עתידיים',       include: true,  liquidity: 'תחנה 05/07/2026', notes: 'נפתח בחודש יולי', auto: null },
    { id: 6, name: 'מתנה אביבה',                  balance: 100000, usage: 'מתנה',                  include: false, liquidity: 'נזיל',            notes: 'ישלח בהעברה בנקאית מתי שיידרש', auto: null },
    { id: 7, name: 'מתנה אירית & יניב',           balance: 300000, usage: 'מתנה',                  include: false, liquidity: 'נזיל חלקית',     notes: 'כולל הסכום הקיים באוצר החייל', auto: null },
  ],
  minCheckingBalance: 30000,
  baseIndex: 140.78,
  indexHistory: {
    '04/2026': 140.78,
  },
  payments: [
    { id: 1,  date: '2026-04-12', base: 144545, idxPct: null,   notIndexed: true,  inForecast: false, status: 'שולם',  notes: 'שולם לפני הכנת הקובץ' },
    { id: 2,  date: '2026-05-27', base: 268440, idxPct: null,   notIndexed: true,  inForecast: true,  status: 'עתידי', notes: 'תשלום 2+3 משולבים' },
    { id: 3,  date: '2026-05-27', base: 144545, idxPct: 0.6409, notIndexed: false, inForecast: true,  status: 'עתידי', notes: 'תשלום 2+3 משולבים' },
    { id: 4,  date: '2026-10-30', base: 144545, idxPct: 0,      notIndexed: false, inForecast: true,  status: 'עתידי', notes: '' },
    { id: 5,  date: '2027-02-28', base: 144545, idxPct: 0,      notIndexed: false, inForecast: true,  status: 'עתידי', notes: '' },
    { id: 6,  date: '2027-07-30', base: 144545, idxPct: 0,      notIndexed: false, inForecast: true,  status: 'עתידי', notes: '' },
    { id: 7,  date: '2027-12-30', base: 144545, idxPct: 0,      notIndexed: false, inForecast: true,  status: 'עתידי', notes: '' },
    { id: 8,  date: '2028-04-30', base: 144545, idxPct: 0,      notIndexed: false, inForecast: true,  status: 'עתידי', notes: '' },
    { id: 9,  date: '2028-09-30', base: 144545, idxPct: 0,      notIndexed: false, inForecast: true,  status: 'עתידי', notes: '' },
    { id: 10, date: '2029-02-28', base: 144545, idxPct: 0,      notIndexed: false, inForecast: true,  status: 'עתידי', notes: '' },
    { id: 11, date: '2029-06-30', base: 144545, idxPct: 0,      notIndexed: false, inForecast: true,  status: 'עתידי', notes: '' },
    { id: 12, date: '2029-11-30', base: 144545, idxPct: 0,      notIndexed: false, inForecast: true,  status: 'עתידי', notes: '' },
    { id: 13, date: '2030-04-30', base: 206491, idxPct: 0,      notIndexed: false, inForecast: true,  status: 'עתידי', notes: 'יתרת 10% במסירה' },
  ],
  expenses: [
    { id: 1,  name: 'מכבי',               amount: 259.59, type: 'הוראת קבע',          notes: 'קרן מכבי - לידור/שירה/מילה' },
    { id: 2,  name: 'סלקום (אינטרנט)',     amount: 89,     type: 'הוראת קבע',          notes: 'תשלום אינטרנט' },
    { id: 3,  name: 'הראל ביטוח בריאות', amount: 100.19, type: 'הוראת קבע',          notes: 'ביטוח בריאות שירה' },
    { id: 4,  name: 'שטראוס מים - תמי 4', amount: 52,     type: 'הוראת קבע',          notes: 'היה 72 ירד ל-52' },
    { id: 5,  name: 'Spotify',            amount: 33.9,   type: 'מנוי',               notes: 'קבוע' },
    { id: 6,  name: 'OpenAI ChatGPT',     amount: 63.64,  type: 'מנוי',               notes: '20$ בחודש' },
    { id: 7,  name: 'HOT mobile',         amount: 42.3,   type: 'הוראת קבע',          notes: 'טלפון - לידור ושירה' },
    { id: 8,  name: 'Apple',              amount: 39.9,   type: 'הוראת קבע / מנוי',  notes: 'iCloud' },
    { id: 9,  name: 'דמי כרטיס',         amount: 0,      type: 'הורדה קבועה',        notes: 'פטור עד 28/10/2026' },
    { id: 10, name: 'Claude',             amount: 63.64,  type: 'מנוי',               notes: '20$ בחודש' },
  ],
  savings: { '04/2026': { amount: 10000, destination: '' }, '05/2026': { amount: 10000, destination: '' } },
  kinderDeps: {},
  elecDeps: {},
  electricityTariff: 0.6376, // ₪ לקוטש כולל מע"מ (תעריף ביתי קבוע, רשות החשמל). עדכן כשמתפרסם שינוי.
  creditCards: [], // [{ id, month: 'MM/YYYY', company, last4, amount, notes }]
  income:      [], // [{ id, month: 'MM/YYYY', category, amount, notes }]
  balanceHistory: [],
  mortgage: {
    amountOverride: null,
    years: 25,
    cpiAssumption: 3.0,
    tracks: [
      { id: 'fixed_unlinked',         name: 'קבועה לא צמודה',           allocation: 33, rate: 5.5, cpiLinked: false, hint: 'בטוחה — תשלום קבוע, ריבית גבוהה' },
      { id: 'fixed_linked',           name: 'קבועה צמודה למדד',         allocation: 0,  rate: 3.8, cpiLinked: true,  hint: 'ריבית נמוכה — הקרן צומחת עם המדד' },
      { id: 'variable_unlinked_5',    name: 'משתנה כל 5 לא צמודה',     allocation: 0,  rate: 5.0, cpiLinked: false, hint: 'ריבית מתעדכנת כל 5 שנים' },
      { id: 'variable_linked_5',      name: 'משתנה כל 5 צמודה למדד',   allocation: 33, rate: 3.5, cpiLinked: true,  hint: 'משתנה כל 5 + הצמדה למדד' },
      { id: 'prime',                  name: 'פריים',                      allocation: 34, rate: 6.1, cpiLinked: false, hint: 'מתעדכנת לפי ריבית בנק ישראל' },
    ],
  },
}

// Defaults for the monthly budget section (autocomplete suggestions)
const INCOME_CATEGORIES   = ['משכורת לידור', 'משכורת שירה', 'קצבה', 'עמדת צילום', 'אחר']
const CARD_COMPANIES = [
  // הכרטיסים שלנו (קודמים ברשימה)
  'בהצדעה - MAX (שירה)',
  'ארגון העובדים - CAL (שירה)',
  'בהצדעה - MAX (לידור)',
  'חבר - ישראכרט (לידור)',
  'Flycard - CAL (לידור)',
  // חברות כלליות
  'ויזה כאל', 'מאסטרקארד', 'ישראכרט', 'אמריקן אקספרס', 'מקס', 'כאל', 'דיינרס',
]

// Generate "MM/YYYY" for current month, plus N months back (for filling chart history)
const currentMonthKey = () => {
  const d = new Date()
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}
const lastNMonths = (n) => {
  const out = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date()
    d.setMonth(d.getMonth() - i)
    out.push(`${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`)
  }
  return out
}

// ============================================================
//  EDITABLE CELL
// ============================================================
function EC({ value, onChange, type = 'text', width, mono, suffix = '', formatValue }) {
  const [editing, setEditing] = useState(false)
  const [local, setLocal]     = useState(value ?? '')

  useEffect(() => { setLocal(value ?? '') }, [value])

  const commit = () => {
    setEditing(false)
    const v = (type === 'number' || type === 'percent') ? parseNum(local) : local
    onChange(v)
  }

  if (editing) {
    return (
      <input
        className="editable-input"
        type="text"
        value={local}
        style={{ width: width || '100%', fontFamily: mono ? 'monospace' : 'inherit' }}
        onChange={e => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
        autoFocus
      />
    )
  }
  let display
  if (formatValue) display = formatValue(value)
  else if (type === 'number')  display = fmt(value)
  else if (type === 'percent') display = (value !== null && value !== undefined) ? `${Number(value).toFixed(4)}%` : '0%'
  else display = value || '—'

  return (
    <span className="editable-value" onClick={() => setEditing(true)} title="לחץ לעריכה">
      {display}{suffix}
    </span>
  )
}

// ============================================================
//  THEME PICKER
// ============================================================
const THEMES = [
  { id: 'light',   label: 'בהיר',              icon: '☀️', desc: 'ברירת המחדל — כחול נקי' },
  { id: 'dark',    label: 'מצב לילה',          icon: '🌙', desc: 'נוח לעיניים בערב' },
  { id: 'neon',    label: 'נאון',              icon: '⚡', desc: 'סגנון עתידני זוהר' },
  { id: 'horizon', label: 'Glowing Horizon',   icon: '🌅', desc: 'כתום וכחול תוססים' },
  { id: 'mono',    label: 'Salt & Pepper',     icon: '⚫', desc: 'מינימליסטי שחור-לבן' },
  { id: 'seaside', label: 'Charming Seaside',  icon: '🌊', desc: 'פסטל ימי וטורקיז רך' },
  { id: 'peach',   label: 'Peach Skyline',     icon: '🍑', desc: 'אפרסק וכחול שמיים' },
  { id: 'spring',  label: 'Spring Energy',     icon: '🌱', desc: 'ירוק-צהוב אנרגטי' },
]

function ThemePicker({ theme, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = THEMES.find(t => t.id === theme) || THEMES[0]

  return (
    <div className="theme-picker" ref={ref}>
      <button
        className="btn btn-secondary btn-sm theme-toggle"
        onClick={() => setOpen(o => !o)}
        title="בחירת ערכת נושא"
        aria-expanded={open}
      >
        {current.icon} {current.label} <span className="theme-chevron">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="theme-menu" role="menu">
          {THEMES.map(t => (
            <button
              key={t.id}
              className={`theme-option ${theme === t.id ? 'active' : ''}`}
              onClick={() => { onChange(t.id); setOpen(false) }}
              role="menuitemradio"
              aria-checked={theme === t.id}
            >
              <span className="theme-option-icon">{t.icon}</span>
              <div className="theme-option-text">
                <strong>{t.label}</strong>
                <span>{t.desc}</span>
              </div>
              {theme === t.id && <span className="theme-option-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ============================================================
//  BALANCE UPDATE MODAL
// ============================================================
function BalanceModal({ account, onSave, onClose }) {
  const oldVal      = Number(account.balance) || 0
  const liveVal     = Number(account.liveBalance) || oldVal
  const hasYield    = !!account.annualYield && Math.abs(liveVal - oldVal) > 0.5
  const [val, setVal]   = useState(String(hasYield ? Math.round(liveVal) : oldVal))
  const [note, setNote] = useState('')
  const newVal  = parseNum(val)
  const diff    = newVal - oldVal
  const diffPct = oldVal !== 0 ? (diff / oldVal) * 100 : 0
  const changed = !isNaN(newVal) && newVal !== oldVal

  const submit = () => {
    if (!changed) { onClose(); return }
    onSave({
      accountId:   account.id,
      accountName: account.name,
      oldValue:    oldVal,
      newValue:    newVal,
      diff,
      note:        note.trim(),
    })
  }

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} dir="rtl">
        <button className="modal-close" onClick={onClose} aria-label="סגור" title="סגור (Esc)">✕</button>
        <h3 className="modal-title">💎 עדכון יתרה</h3>
        <div className="modal-account-name">{account.name}</div>

        <div className="modal-row">
          <span>יתרה אחרונה שאושרה:</span>
          <strong>{fmt(oldVal)}</strong>
        </div>
        {hasYield && (
          <div className="modal-row" style={{ background: 'var(--green-light)', color: 'var(--green)' }}>
            <span>📈 צפי לפי תשואה {account.annualYield}%:</span>
            <strong>{fmt(liveVal)}</strong>
          </div>
        )}

        <div className="modal-field">
          <label className="modal-label">יתרה חדשה (₪)</label>
          <input
            className="modal-input"
            type="text"
            value={val}
            onChange={e => setVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
            onFocus={e => e.target.select()}
            autoFocus
            inputMode="decimal"
          />
        </div>

        {changed && (
          <div className={`modal-diff ${diff >= 0 ? 'positive' : 'negative'}`}>
            <span>{diff >= 0 ? '⬆ רווח' : '⬇ הפסד'}</span>
            <strong>{diff >= 0 ? '+' : ''}{fmt(diff)}</strong>
            <span style={{ fontSize: '0.85em', opacity: 0.85 }}>
              ({diffPct >= 0 ? '+' : ''}{diffPct.toFixed(3)}%)
            </span>
          </div>
        )}

        <div className="modal-field">
          <label className="modal-label">הערה (אופציונלי)</label>
          <input
            className="modal-input"
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="לדוגמה: עדכון שבועי / תשואה חודשית / הפקדה"
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
          />
        </div>

        <div className="modal-info">
          📅 התאריך והשעה יישמרו אוטומטית · ייווסף רישום להיסטוריית מעקב הרווחים
        </div>

        <div className="modal-actions">
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={!changed}
            title={!changed ? 'אין שינוי לשמירה' : 'שמור (Enter)'}
          >
            ✓ אשר ושמור (Enter)
          </button>
          <button className="btn btn-outline" onClick={onClose}>
            ביטול (Esc)
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================
//  SAVINGS UPDATE MODAL
// ============================================================
function SavingsModal({ month, existing, onSave, onClose }) {
  const [amount, setAmount]           = useState(String(existing?.amount ?? ''))
  const [destination, setDestination] = useState(existing?.destination || '')

  const submit = () => {
    onSave(month, { amount, destination })
  }

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} dir="rtl">
        <button className="modal-close" onClick={onClose} aria-label="סגור" title="סגור (Esc)">✕</button>
        <h3 className="modal-title">🏦 עדכון חיסכון חודשי</h3>
        <div className="modal-account-name">חודש: {month}</div>

        <div className="modal-field">
          <label className="modal-label">סכום שנחסך (₪)</label>
          <input
            className="modal-input"
            type="text"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
            onFocus={e => e.target.select()}
            placeholder="לדוגמה: 10000"
            autoFocus
            inputMode="decimal"
          />
        </div>

        <div className="modal-field">
          <label className="modal-label">לאן הועבר הסכום? <span style={{ color: 'var(--subtext)', fontWeight: 400 }}>(לסדר אישי בלבד)</span></label>
          <input
            className="modal-input"
            type="text"
            value={destination}
            onChange={e => setDestination(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
            placeholder="לדוגמה: אוצר החייל - מגדל"
            list="savings-destinations"
          />
          <datalist id="savings-destinations">
            <option value="אוצר החייל - מגדל" />
            <option value="אוצר החייל - אלטשולר" />
            <option value="אוצר החייל - ילין לפידות" />
            <option value="בנק לאומי - פיקדון" />
            <option value="נשאר בעו״ש" />
          </datalist>
        </div>

        <div className="modal-info">
          📝 הסכום והיעד יישמרו לחודש {month}. ניתן לערוך בכל עת.
        </div>

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={submit}>
            ✓ אשר ושמור (Enter)
          </button>
          <button className="btn btn-outline" onClick={onClose}>
            ביטול (Esc)
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================
//  MAIN APP
// ============================================================
export default function App() {
  const [data, setData] = useState(() => {
    try {
      const s = localStorage.getItem('fin-v2')
      if (s) {
        const loaded = JSON.parse(s)
        // Migration: ensure indexHistory exists
        if (!loaded.indexHistory) loaded.indexHistory = { '04/2026': loaded.baseIndex || 140.78 }
        // Migration: ensure balanceHistory exists
        if (!loaded.balanceHistory) loaded.balanceHistory = []
        if (!Array.isArray(loaded.creditCards)) loaded.creditCards = []
        if (!Array.isArray(loaded.income))      loaded.income      = []
        // Migration: ensure mortgage config exists
        if (!loaded.mortgage) loaded.mortgage = INIT.mortgage
        // Migration: drop legacy altshuler auto-tracking opening/adj (kinder/elec kept for manual log)
        delete loaded.altshulerOpening
        delete loaded.altshulerAdj
        if (!loaded.kinderDeps) loaded.kinderDeps = {}
        if (!loaded.elecDeps)   loaded.elecDeps   = {}
        // Migration: elecDeps from { month: amount } → { month: { amount, kwh } }
        loaded.elecDeps = Object.fromEntries(
          Object.entries(loaded.elecDeps).map(([k, v]) => {
            if (v && typeof v === 'object' && 'amount' in v) return [k, v]
            return [k, { amount: v ?? null, kwh: null }]
          })
        )
        if (loaded.electricityTariff == null) loaded.electricityTariff = 0.6376
        // Migration: savings from { month: amount } → { month: { amount, destination } }
        loaded.savings = Object.fromEntries(
          Object.entries(loaded.savings || {}).map(([k, v]) => {
            if (v && typeof v === 'object' && 'amount' in v) return [k, v]
            return [k, { amount: v ?? null, destination: '' }]
          })
        )
        // Strip legacy idxLocked field if present
        loaded.payments = (loaded.payments || []).map(p => {
          const { idxLocked, ...rest } = p
          return rest
        })
        // Migration: strip 'altshuler' auto so balance becomes manually editable
        // + remove the auto-savings indicator account (now lives only in the savings tab)
        loaded.accounts = (loaded.accounts || [])
          .filter(a => a.auto !== 'savings')
          .map(a => (a.auto === 'altshuler' ? { ...a, auto: null } : a))
        return loaded
      }
    } catch (_) {}
    return INIT
  })
  const [tab, setTab]     = useState('dashboard')
  const [saved, setSaved] = useState(false)
  const [editingAccountId, setEditingAccountId] = useState(null)
  const [editingSavingsMonth, setEditingSavingsMonth] = useState(null)
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('fin-theme') || 'light' } catch { return 'light' }
  })
  const [apiData, setApiData]     = useState([])
  const [apiStatus, setApiStatus] = useState({ status: 'idle', lastFetch: null, error: null })

  useEffect(() => {
    localStorage.setItem('fin-v2', JSON.stringify(data))
    setSaved(true)
    const t = setTimeout(() => setSaved(false), 1200)
    return () => clearTimeout(t)
  }, [data])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem('fin-theme', theme) } catch {}
  }, [theme])

  const refreshFromCbs = useCallback(async () => {
    setApiStatus(s => ({ ...s, status: 'loading' }))
    try {
      const items = await fetchCbsBuildingIndex()
      setApiData(items)
      setApiStatus({ status: 'connected', lastFetch: new Date().toISOString(), error: null })
    } catch (err) {
      setApiStatus({ status: 'error', lastFetch: null, error: err.message || 'שגיאה לא ידועה' })
    }
  }, [])

  useEffect(() => { refreshFromCbs() }, [refreshFromCbs])

  // ---------- derived ----------
  const savingsTotal = useMemo(
    () => Object.values(data.savings || {}).reduce((s, v) => {
      const amount = (v && typeof v === 'object') ? v.amount : v
      return s + (parseNum(amount) || 0)
    }, 0),
    [data.savings]
  )

  const accounts = useMemo(() =>
    data.accounts.map(a => {
      const base = a.auto === 'savings' ? { ...a, balance: savingsTotal } : a
      const liveBalance = computeLive(base, data.balanceHistory || [])
      return { ...base, liveBalance }
    }),
    [data.accounts, savingsTotal, data.balanceHistory]
  )

  const totals = useMemo(() => {
    const all      = accounts.reduce((s, a) => s + (a.liveBalance || 0), 0)
    const included = accounts.filter(a => a.include).reduce((s, a) => s + (a.liveBalance || 0), 0)
    const excluded = accounts.filter(a => !a.include).reduce((s, a) => s + (a.liveBalance || 0), 0)
    const available = included - (data.minCheckingBalance || 0)
    return { all, included, excluded, available }
  }, [accounts, data.minCheckingBalance])

  const payCals = useMemo(() => {
    const withF = data.payments.map(p => {
      const idxAdd = (p.notIndexed || p.idxPct === null)
        ? 0 : p.base * (parseNum(p.idxPct) / 100)
      return { ...p, idxAdd, final: p.base + idxAdd }
    })
    let runBal = totals.available
    let runRem = withF.reduce((s, p) => s + p.final, 0)
    return withF.map(p => {
      runRem -= p.final
      if (p.inForecast) runBal -= p.final
      return { ...p, balAfter: runBal, remAfter: runRem }
    })
  }, [data.payments, totals.available])

  const expenseTotal = useMemo(
    () => data.expenses.reduce((s, e) => s + (parseNum(e.amount) || 0), 0),
    [data.expenses]
  )

  // ---------- mutators ----------
  const upd = useCallback((key, val) => setData(d => ({ ...d, [key]: val })), [])

  const updAccount = useCallback((id, field, val) =>
    setData(d => ({ ...d, accounts: d.accounts.map(a => a.id === id ? { ...a, [field]: val } : a) })), [])

  const addAccount = useCallback(() =>
    setData(d => ({ ...d, accounts: [...d.accounts, { id: Date.now(), name: 'מקור חדש', balance: 0, usage: '', include: false, liquidity: '', notes: '', auto: null }] })), [])

  const delAccount = useCallback((id) =>
    setData(d => ({ ...d, accounts: d.accounts.filter(a => a.id !== id) })), [])

  const moveAccount = useCallback((id, direction) => {
    setData(d => {
      const idx = d.accounts.findIndex(a => a.id === id)
      if (idx < 0) return d
      const newIdx = idx + direction
      if (newIdx < 0 || newIdx >= d.accounts.length) return d
      const next = [...d.accounts]
      ;[next[idx], next[newIdx]] = [next[newIdx], next[idx]]
      return { ...d, accounts: next }
    })
  }, [])

  const saveBalanceUpdate = useCallback(({ accountId, accountName, oldValue, newValue, diff, note }) => {
    const now = new Date().toISOString()
    setData(d => ({
      ...d,
      accounts: d.accounts.map(a =>
        a.id === accountId ? { ...a, balance: newValue, balanceAsOf: now } : a
      ),
      balanceHistory: [
        ...(d.balanceHistory || []),
        {
          id: Date.now(),
          accountId,
          accountName,
          date: now,
          oldValue,
          newValue,
          diff,
          note,
        },
      ],
    }))
    setEditingAccountId(null)
  }, [])

  const delHistoryEntry = useCallback((id) =>
    setData(d => ({ ...d, balanceHistory: (d.balanceHistory || []).filter(e => e.id !== id) })), [])

  const updPayment = useCallback((id, field, val) =>
    setData(d => ({ ...d, payments: d.payments.map(p => p.id === id ? { ...p, [field]: val } : p) })), [])

  const updIndexEntry = useCallback((month, val) =>
    setData(d => ({ ...d, indexHistory: { ...d.indexHistory, [month]: val === '' ? null : parseNum(val) } })), [])

  const delIndexEntry = useCallback((month) =>
    setData(d => {
      const next = { ...d.indexHistory }
      delete next[month]
      return { ...d, indexHistory: next }
    }), [])

  const updExpense = useCallback((id, field, val) =>
    setData(d => ({ ...d, expenses: d.expenses.map(e => e.id === id ? { ...e, [field]: val } : e) })), [])

  const addExpense = useCallback(() =>
    setData(d => ({ ...d, expenses: [...d.expenses, { id: Date.now(), name: 'הוצאה חדשה', amount: 0, type: '', notes: '' }] })), [])

  const delExpense = useCallback((id) =>
    setData(d => ({ ...d, expenses: d.expenses.filter(e => e.id !== id) })), [])

  const addCard = useCallback((month) => setData(d => ({
    ...d,
    creditCards: [...(d.creditCards || []), { id: Date.now(), month, company: '', last4: '', amount: 0, notes: '' }],
  })), [])
  const updCard = useCallback((id, field, val) => setData(d => ({
    ...d,
    creditCards: (d.creditCards || []).map(c => c.id === id ? { ...c, [field]: val } : c),
  })), [])
  const delCard = useCallback((id) => setData(d => ({
    ...d,
    creditCards: (d.creditCards || []).filter(c => c.id !== id),
  })), [])

  const addIncome = useCallback((month, category = '') => setData(d => ({
    ...d,
    income: [...(d.income || []), { id: Date.now(), month, category, amount: 0, notes: '' }],
  })), [])
  const updIncome = useCallback((id, field, val) => setData(d => ({
    ...d,
    income: (d.income || []).map(i => i.id === id ? { ...i, [field]: val } : i),
  })), [])
  const delIncome = useCallback((id) => setData(d => ({
    ...d,
    income: (d.income || []).filter(i => i.id !== id),
  })), [])

  const copyMonthBudget = useCallback((fromMonth, toMonth) => {
    setData(d => {
      const ts = Date.now()
      const newCards = (d.creditCards || [])
        .filter(c => c.month === fromMonth)
        .map((c, idx) => ({ ...c, id: ts + idx, month: toMonth }))
      const newIncome = (d.income || [])
        .filter(i => i.month === fromMonth)
        .map((i, idx) => ({ ...i, id: ts + 9999 + idx, month: toMonth }))
      return {
        ...d,
        creditCards: [...(d.creditCards || []), ...newCards],
        income:      [...(d.income      || []), ...newIncome],
      }
    })
  }, [])

  const updKinder = useCallback((month, val) =>
    setData(d => ({ ...d, kinderDeps: { ...(d.kinderDeps || {}), [month]: val === '' ? null : parseNum(val) } })), [])

  const updElec = useCallback((month, field, val) => {
    setData(d => {
      const tariff  = parseNum(d.electricityTariff) || 0.6376
      const current = (d.elecDeps && d.elecDeps[month]) || { amount: null, kwh: null }
      const parsed  = val === '' || val == null ? null : parseNum(val)
      const next    = { ...current, [field]: parsed }

      // Live two-way sync: כל הקלדה בקוט"ש מעדכנת את הסכום ולהיפך, לפי התעריף
      if (parsed != null && tariff > 0) {
        if (field === 'kwh')    next.amount = +(parsed * tariff).toFixed(2)
        if (field === 'amount') next.kwh    = +(parsed / tariff).toFixed(2)
      }
      // If the user cleared this field, also clear the linked one so the row "resets"
      if (parsed == null) {
        if (field === 'kwh')    next.amount = null
        if (field === 'amount') next.kwh    = null
      }

      return { ...d, elecDeps: { ...(d.elecDeps || {}), [month]: next } }
    })
  }, [])

  const updSaving = useCallback((month, payload) =>
    setData(d => ({
      ...d,
      savings: {
        ...d.savings,
        [month]: {
          amount: payload?.amount === '' || payload?.amount == null ? null : parseNum(payload.amount),
          destination: (payload?.destination || '').trim(),
        },
      },
    })), [])

  const exportData = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `financial-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
  }

  const importData = (e) => {
    const file = e.target.files[0]; if (!file) return
    const r = new FileReader()
    r.onload = ev => { try { setData(JSON.parse(ev.target.result)) } catch { alert('שגיאה בקריאת הקובץ') } }
    r.readAsText(file)
    e.target.value = ''
  }

  const resetData = () => {
    if (window.confirm('האם לאפס את כל הנתונים לברירת המחדל?')) setData(INIT)
  }

  const updMortgage = useCallback((patch) =>
    setData(d => ({ ...d, mortgage: { ...d.mortgage, ...patch } })), [])

  // ---------- render ----------
  const TABS = [
    { id: 'dashboard', label: 'דשבורד',            icon: '📊' },
    { id: 'money',     label: 'ריכוז כספים',       icon: '💰' },
    { id: 'payments',  label: 'ניהול תשלומי דירה', icon: '🏠' },
    { id: 'expenses',  label: 'הוצאות חודשיות',    icon: '📋' },
    { id: 'savings',   label: 'חיסכון חודשי',      icon: '🏦' },
    { id: 'index',     label: 'מדד תשומות בנייה', icon: '📈' },
    { id: 'mortgage',  label: 'ניהול משכנתא',      icon: '🏛️' },
  ]

  return (
    <div className="app" dir="rtl">
      <header className="header">
        <div className="header-content">
          <h1>💎 מערכת ניהול כספים — דירה וחסכונות</h1>
          <div className="header-actions">
            {saved && <span className="save-status">✓ נשמר</span>}
            <button className="btn btn-secondary btn-sm" onClick={exportData}>ייצא JSON</button>
            <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
              ייבא JSON
              <input type="file" accept=".json" onChange={importData} style={{ display: 'none' }} />
            </label>
            <ThemePicker theme={theme} onChange={setTheme} />
            {/* כפתור איפוס הוסתר. אם אי פעם נדרש: ניתן להחזיר ע"י הסרת התיוג, או לאפס דרך localStorage.removeItem('fin-v2') ב-DevTools */}
          </div>
        </div>
        <nav className="tabs">
          {TABS.map(t => (
            <button key={t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
              {t.icon} {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="main">
        {tab === 'dashboard' && <Dashboard totals={totals} payCals={payCals} expenseTotal={expenseTotal} savingsTotal={savingsTotal} balanceHistory={data.balanceHistory || []} accounts={accounts} />}
        {tab === 'money'     && <MoneyTab accounts={accounts} totals={totals} minCheck={data.minCheckingBalance} history={data.balanceHistory || []} onUpdAcc={updAccount} onAdd={addAccount} onDel={delAccount} onMove={moveAccount} onUpdMin={v => upd('minCheckingBalance', v)} onEditBalance={setEditingAccountId} onDelHistory={delHistoryEntry} />}
        {tab === 'payments'  && <PaymentsTab payCals={payCals} totals={totals} baseIdx={data.baseIndex} onUpdPay={updPayment} onUpdBase={v => upd('baseIndex', v)} />}
        {tab === 'mortgage'  && <MortgageTab mortgage={data.mortgage} totals={totals} payCals={payCals} onUpd={updMortgage} />}
        {tab === 'index'     && <IndexTab indexHistory={data.indexHistory} baseIdx={data.baseIndex} apiData={apiData} apiStatus={apiStatus} onRefresh={refreshFromCbs} onUpdEntry={updIndexEntry} onDelEntry={delIndexEntry} onUpdBase={v => upd('baseIndex', v)} />}
        {tab === 'expenses'  && <ExpensesTab expenses={data.expenses} expenseTotal={expenseTotal} kinderDeps={data.kinderDeps || {}} elecDeps={data.elecDeps || {}} elecTariff={data.electricityTariff ?? 0.6376} creditCards={data.creditCards || []} income={data.income || []} onUpdExp={updExpense} onAddExp={addExpense} onDelExp={delExpense} onUpdKinder={updKinder} onUpdElec={updElec} onUpdElecTariff={v => upd('electricityTariff', parseNum(v))} onAddCard={addCard} onUpdCard={updCard} onDelCard={delCard} onAddIncome={addIncome} onUpdIncome={updIncome} onDelIncome={delIncome} onCopyMonth={copyMonthBudget} />}
        {tab === 'savings'   && <SavingsTab savings={data.savings} savingsTotal={savingsTotal} onEdit={setEditingSavingsMonth} />}
      </main>

      {editingAccountId !== null && (() => {
        const acc = accounts.find(a => a.id === editingAccountId)
        if (!acc) return null
        return (
          <BalanceModal
            account={acc}
            onSave={saveBalanceUpdate}
            onClose={() => setEditingAccountId(null)}
          />
        )
      })()}

      {editingSavingsMonth && (
        <SavingsModal
          month={editingSavingsMonth}
          existing={data.savings?.[editingSavingsMonth]}
          onSave={(month, payload) => { updSaving(month, payload); setEditingSavingsMonth(null) }}
          onClose={() => setEditingSavingsMonth(null)}
        />
      )}
    </div>
  )
}

// ============================================================
//  DASHBOARD
// ============================================================
function Dashboard({ totals, payCals, expenseTotal, savingsTotal, balanceHistory, accounts }) {
  const totalCost    = payCals.reduce((s, p) => s + p.final, 0)
  const totalIdx     = payCals.reduce((s, p) => s + p.idxAdd, 0)
  const totalBase    = payCals.reduce((s, p) => s + p.base, 0)
  const paid         = payCals.filter(p => p.status === 'שולם').reduce((s, p) => s + p.final, 0)
  const remaining    = payCals.filter(p => p.status === 'עתידי').reduce((s, p) => s + p.final, 0)
  const nextPay      = payCals.find(p => p.status === 'עתידי')
  const gap          = totals.available - remaining
  const paidPct      = totalCost > 0 ? (paid / totalCost) * 100 : 0

  // Days until next payment + alert urgency
  const nextPayDays = nextPay
    ? Math.ceil((new Date(nextPay.date).getTime() - Date.now()) / 86400000)
    : null
  const showAlert = nextPayDays !== null && nextPayDays <= 60 && nextPayDays >= 0
  const urgency = nextPayDays === null ? null
                : nextPayDays <= 14 ? 'urgent'
                : nextPayDays <= 30 ? 'soon'
                : 'planned'

  // Net worth over time — derived from balanceHistory + accounts
  const netWorthSnapshots = useMemo(() => {
    if (!balanceHistory || balanceHistory.length === 0) return []
    const sorted = [...balanceHistory].sort((a, b) => new Date(a.date) - new Date(b.date))
    const startValues = {}
    sorted.forEach(h => {
      if (!(h.accountId in startValues)) startValues[h.accountId] = h.oldValue
    })
    accounts.forEach(a => {
      if (!(a.id in startValues)) startValues[a.id] = a.liveBalance ?? a.balance ?? 0
    })
    const values = { ...startValues }
    const snaps = []
    sorted.forEach(h => {
      values[h.accountId] = h.newValue
      const sum = Object.values(values).reduce((s, v) => s + (v || 0), 0)
      snaps.push({ date: h.date, value: sum, label: h.accountName })
    })
    return snaps
  }, [balanceHistory, accounts])

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: '1.35rem', fontWeight: 700, color: 'var(--primary)', marginBottom: 4 }}>דשבורד</h2>
        <div style={{ fontSize: '0.82rem', color: 'var(--subtext)' }}>עדכון אחרון: {fmtDate(new Date())}</div>
      </div>

      {/* Upcoming payment alert */}
      {showAlert && (
        <div className={`payment-alert payment-alert-${urgency}`}>
          <div className="alert-left">
            <span className="alert-icon">{urgency === 'urgent' ? '🚨' : urgency === 'soon' ? '⏰' : '📅'}</span>
            <div>
              <strong className="alert-title">
                {urgency === 'urgent' && 'תשלום קרב!'}
                {urgency === 'soon'   && 'תשלום בקרוב'}
                {urgency === 'planned'&& 'תשלום מתוכנן'}
                {' '}— תשלום #{nextPay.id}
              </strong>
              <div className="alert-sub">
                {nextPayDays === 0 ? 'היום' : nextPayDays === 1 ? 'מחר' : `בעוד ${nextPayDays} ימים`}
                {' · '}תאריך: {fmtDate(nextPay.date)}
                {nextPay.notes ? ` · ${nextPay.notes}` : ''}
              </div>
            </div>
          </div>
          <div className="alert-amount">{fmt(nextPay.final)}</div>
        </div>
      )}

      <div className="cards-grid">
        <div className="card card-blue">
          <div className="card-icon">💰</div>
          <div className="card-label">סה"כ כל היתרות</div>
          <div className="card-value">{fmt(totals.all)}</div>
        </div>
        <div className="card card-green">
          <div className="card-icon">🏗️</div>
          <div className="card-label">זמין לתשלומי קבלן</div>
          <div className="card-value">{fmt(totals.available)}</div>
          <div className="card-sub">כולל בחישוב בלבד</div>
        </div>
        <div className={`card ${gap >= 0 ? 'card-teal' : 'card-red'}`}>
          <div className="card-icon">{gap >= 0 ? '✅' : '⚠️'}</div>
          <div className="card-label">פער: זמין מול נדרש</div>
          <div className={`card-value ${gap < 0 ? 'negative' : ''}`}>{fmt(gap)}</div>
          <div className="card-sub">נדרש לתשלומים: {fmt(remaining)}</div>
        </div>
        <div className="card card-purple">
          <div className="card-icon">🏠</div>
          <div className="card-label">עלות דירה כוללת</div>
          <div className="card-value">{fmt(totalCost)}</div>
          <div className="card-sub">מדד: {fmt(totalIdx)} | בסיס: {fmt(totalBase)}</div>
        </div>
        {nextPay && (
          <div className="card card-amber">
            <div className="card-icon">📅</div>
            <div className="card-label">תשלום הבא (#{nextPay.id})</div>
            <div className="card-value">{fmt(nextPay.final)}</div>
            <div className="card-sub">{nextPay.date}</div>
          </div>
        )}
        <div className="card card-orange">
          <div className="card-icon">📋</div>
          <div className="card-label">הוצאות חודשיות קבועות</div>
          <div className="card-value">{fmt(expenseTotal)}</div>
        </div>
        <div className="card" style={{ borderTop: '4px solid #8b5cf6' }}>
          <div className="card-icon">🏦</div>
          <div className="card-label">חיסכון שנצבר</div>
          <div className="card-value">{fmt(savingsTotal)}</div>
        </div>
        <div className="card" style={{ borderTop: '4px solid #94a3b8' }}>
          <div className="card-icon">🔒</div>
          <div className="card-label">לא כלול בחישוב</div>
          <div className="card-value">{fmt(totals.excluded)}</div>
          <div className="card-sub">מתנות וכסף שוטף</div>
        </div>
      </div>

      {/* Progress */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <strong style={{ fontSize: '0.95rem' }}>התקדמות תשלומי דירה</strong>
          <span style={{ color: 'var(--subtext)', fontSize: '0.82rem' }}>{paidPct.toFixed(1)}% שולם</span>
        </div>
        <div className="progress-bar-wrap" style={{ height: 14, marginBottom: 14 }}>
          <div className="progress-bar-fill" style={{ width: `${Math.min(paidPct, 100)}%`, background: 'var(--green)' }} />
        </div>
        <div className="timeline-scroll">
          {payCals.map(p => (
            <div key={p.id} className={`tl-item ${p.status === 'שולם' ? 'paid' : 'future'}`}>
              <span className="tl-num">#{p.id}</span>
              <span className="tl-date">{p.date?.slice(0, 7)}</span>
              <span className="tl-amount">{fmt(p.final)}</span>
              <span style={{ fontSize: '0.7rem', marginTop: 4, display: 'block' }}>{p.status}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Balance projection warning */}
      {payCals.some(p => p.status === 'עתידי' && p.balAfter < 0) && (
        <div className="info-bar amber" style={{ marginBottom: 20 }}>
          ⚠️ שים לב: החל מתשלום #{payCals.find(p => p.status === 'עתידי' && p.balAfter < 0)?.id} היתרה הזמינה הופכת שלילית — יידרשו כספי מתנות או חסכונות נוספים.
        </div>
      )}

      {/* Net worth chart */}
      <NetWorthChart snapshots={netWorthSnapshots} />
    </div>
  )
}

// ============================================================
//  NET WORTH CHART (SVG line chart)
// ============================================================
function NetWorthChart({ snapshots }) {
  if (!snapshots || snapshots.length < 2) {
    return (
      <div className="card" style={{ marginTop: 16, padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--primary)', marginBottom: 8 }}>
          📈 גרף הון עצמי לאורך זמן
        </div>
        <div style={{ fontSize: '0.85rem', color: 'var(--subtext)', lineHeight: 1.6 }}>
          צריך לפחות 2 עדכוני יתרה כדי להציג גרף.<br />
          עדכן יתרות בריכוז כספים — כל עדכון יוצר נקודה בגרף ויראה את המגמה לאורך זמן.
        </div>
      </div>
    )
  }

  const W = 800, H = 220
  const padL = 70, padR = 20, padT = 20, padB = 36
  const innerW = W - padL - padR
  const innerH = H - padT - padB

  const values = snapshots.map(s => s.value)
  const minV = Math.min(...values)
  const maxV = Math.max(...values)
  const range = maxV - minV || 1

  const xPos = (i) => padL + (snapshots.length === 1 ? innerW/2 : (i / (snapshots.length - 1)) * innerW)
  const yPos = (v) => padT + (1 - (v - minV) / range) * innerH

  const polyPoints = snapshots.map((s, i) => `${xPos(i)},${yPos(s.value)}`).join(' ')
  const areaPoints = `${padL},${padT + innerH} ${polyPoints} ${xPos(snapshots.length-1)},${padT + innerH}`

  const change      = values[values.length - 1] - values[0]
  const changePct   = values[0] !== 0 ? (change / values[0]) * 100 : 0
  const positive    = change >= 0

  return (
    <div className="card" style={{ marginTop: 16, padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <strong style={{ fontSize: '1rem', color: 'var(--primary)' }}>📈 גרף הון עצמי לאורך זמן</strong>
        <div style={{ display: 'flex', gap: 16, fontSize: '0.85rem' }}>
          <span>נקודות: <strong>{snapshots.length}</strong></span>
          <span>שינוי כולל: <strong style={{ color: positive ? 'var(--green)' : 'var(--red)' }}>
            {positive ? '+' : ''}{fmt(change)} ({positive ? '+' : ''}{changePct.toFixed(2)}%)
          </strong></span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 240 }}>
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map(t => (
          <line key={t}
            x1={padL} y1={padT + t * innerH}
            x2={W - padR} y2={padT + t * innerH}
            stroke="var(--border)" strokeDasharray="3 3" />
        ))}
        {/* Y-axis labels */}
        {[0, 0.5, 1].map(t => (
          <text key={t}
            x={padL - 8} y={padT + (1 - t) * innerH + 4}
            textAnchor="end" fontSize="10" fill="var(--subtext)">
            {fmt(minV + t * range)}
          </text>
        ))}
        {/* Area */}
        <polygon points={areaPoints} fill="var(--primary)" opacity="0.12" />
        {/* Line */}
        <polyline points={polyPoints} fill="none" stroke="var(--primary)" strokeWidth="2.5" />
        {/* Points */}
        {snapshots.map((s, i) => (
          <g key={i}>
            <circle cx={xPos(i)} cy={yPos(s.value)} r="4.5" fill="var(--card)" stroke="var(--primary)" strokeWidth="2" />
            <title>{fmtDate(s.date)} — {fmt(s.value)} ({s.label})</title>
          </g>
        ))}
        {/* X-axis labels (first, middle, last) */}
        {[0, Math.floor(snapshots.length/2), snapshots.length-1].filter((v, i, a) => a.indexOf(v) === i).map(i => (
          <text key={i}
            x={xPos(i)} y={H - padB + 18}
            textAnchor="middle" fontSize="10" fill="var(--subtext)">
            {fmtDate(snapshots[i].date)}
          </text>
        ))}
      </svg>
      <div style={{ fontSize: '0.75rem', color: 'var(--subtext)', textAlign: 'center', marginTop: 4 }}>
        רחף מעל נקודה לצפיה בפרטים מלאים
      </div>
    </div>
  )
}

// ============================================================
//  MONEY CONSOLIDATION TAB
// ============================================================
function MoneyTab({ accounts, totals, minCheck, history, onUpdAcc, onAdd, onDel, onMove, onUpdMin, onEditBalance, onDelHistory }) {
  // Build a map of accountId → last update date for showing "updated X days ago"
  const lastUpdateMap = useMemo(() => {
    const m = {}
    history.forEach(h => {
      if (!m[h.accountId] || new Date(h.date) > new Date(m[h.accountId])) {
        m[h.accountId] = h.date
      }
    })
    return m
  }, [history])

  return (
    <div>
      <div className="section-header">
        <h2>ריכוז כספים</h2>
        <button className="btn btn-outline btn-sm" onClick={onAdd}>+ הוסף מקור</button>
      </div>

      <div className="info-bar">
        💡 לחץ על יתרה כדי לעדכן ולרשום בהיסטוריה. <strong>תשואה שנתית %</strong> — הזן תשואה צפויה (לדוגמה 4.5 לקרן כספית) והמערכת תחשב את היתרה הצפויה לפי הזמן שעבר.
      </div>

      <div className="totals-row">
        <div className="total-chip">
          <div className="tc-label">סה"כ כל היתרות</div>
          <div className="tc-value blue">{fmt(totals.all)}</div>
        </div>
        <div className="total-chip">
          <div className="tc-label">סה"כ כלול בחישוב</div>
          <div className="tc-value green">{fmt(totals.included)}</div>
        </div>
        <div className="total-chip">
          <div className="tc-label">זמין לתשלומי קבלן</div>
          <div className="tc-value blue">{fmt(totals.available)}</div>
        </div>
        <div className="total-chip">
          <div className="tc-label">לא כלול</div>
          <div className="tc-value" style={{ color: 'var(--subtext)' }}>{fmt(totals.excluded)}</div>
        </div>
        <div className="total-chip">
          <div className="tc-label">סכום בעו"ש אשר אינו מחושב</div>
          <div className="tc-value" style={{ color: 'var(--subtext)' }}>
            <input
              className="setting-input"
              type="text"
              value={minCheck}
              style={{ width: 100 }}
              onChange={e => onUpdMin(parseNum(e.target.value))}
            />
          </div>
        </div>
      </div>

      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th style={{ width: 60, textAlign: 'center' }} title="סידור מחדש">סדר</th>
              <th>מקור</th>
              <th>יתרה נוכחית</th>
              <th title="תשואה שנתית צפויה — לחישוב יתרה מצטברת">תשואה שנתית %</th>
              <th>שימוש / סימון</th>
              <th>כלול בחישוב</th>
              <th>נזילות</th>
              <th>הערות</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a, i) => (
              <tr key={a.id}>
                <td style={{ textAlign: 'center', padding: '6px' }}>
                  <div className="move-controls">
                    <button
                      className="move-btn"
                      onClick={() => onMove(a.id, -1)}
                      disabled={i === 0}
                      title="העלה למעלה"
                      aria-label="העלה"
                    >▲</button>
                    <button
                      className="move-btn"
                      onClick={() => onMove(a.id, 1)}
                      disabled={i === accounts.length - 1}
                      title="הורד למטה"
                      aria-label="הורד"
                    >▼</button>
                  </div>
                </td>
                <td>
                  {a.auto ? (
                    <span>{a.name}</span>
                  ) : (
                    <EC value={a.name} onChange={v => onUpdAcc(a.id, 'name', v)} />
                  )}
                </td>
                <td>
                  {a.auto ? (
                    <span>
                      <span className="badge badge-auto">{fmt(a.liveBalance)}</span>
                      <span style={{ fontSize: '0.7rem', color: 'var(--purple)', marginRight: 4 }}>אוטו</span>
                    </span>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                      <button
                        className="balance-btn"
                        onClick={() => onEditBalance(a.id)}
                        title="לחץ לעדכון יתרה ורישום בהיסטוריה"
                      >
                        <span>{fmt(a.liveBalance)}</span>
                        <span className="edit-icon">✏️</span>
                      </button>
                      {a.annualYield && Math.abs((a.liveBalance || 0) - (a.balance || 0)) > 0.5 && (
                        <span className="yield-badge" title={`יתרה אחרונה שאושרה: ${fmt(a.balance)}`}>
                          📈 צפי לפי {a.annualYield}% (מצטבר: {fmt((a.liveBalance || 0) - (a.balance || 0))})
                        </span>
                      )}
                      {lastUpdateMap[a.id] && (() => {
                        const days = Math.floor((Date.now() - new Date(lastUpdateMap[a.id])) / 86400000)
                        return (
                          <span style={{ fontSize: '0.7rem', color: 'var(--subtext)', marginTop: 2, paddingRight: 4 }}>
                            🕒 עודכן {days === 0 ? 'היום' : days === 1 ? 'אתמול' : `לפני ${days} ימים`}
                          </span>
                        )
                      })()}
                    </div>
                  )}
                </td>
                <td>
                  {a.auto ? (
                    <span style={{ color: 'var(--subtext)', fontSize: '0.78rem' }}>—</span>
                  ) : (
                    <EC
                      value={a.annualYield || ''}
                      onChange={v => onUpdAcc(a.id, 'annualYield', v === '' ? null : parseNum(v))}
                      formatValue={v => v ? `${v}%` : '—'}
                      width={60}
                    />
                  )}
                </td>
                <td><EC value={a.usage} onChange={v => onUpdAcc(a.id, 'usage', v)} /></td>
                <td>
                  <label className="toggle">
                    <input type="checkbox" checked={a.include} onChange={e => onUpdAcc(a.id, 'include', e.target.checked)} />
                    <span className="toggle-slider" />
                  </label>
                </td>
                <td><EC value={a.liquidity} onChange={v => onUpdAcc(a.id, 'liquidity', v)} /></td>
                <td><EC value={a.notes} onChange={v => onUpdAcc(a.id, 'notes', v)} /></td>
                <td>
                  {!a.auto && (
                    <button className="btn btn-ghost btn-sm" onClick={() => { if (window.confirm('למחוק?')) onDel(a.id) }}>✕</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="summary-row">
              <td colSpan={2}>סה"כ</td>
              <td>{fmt(totals.all)}</td>
              <td colSpan={6} style={{ color: 'var(--subtext)', fontSize: '0.8rem' }}>
                כלול: {fmt(totals.included)} | לא כלול: {fmt(totals.excluded)} | זמין לקבלן: {fmt(totals.available)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <BalanceHistorySection history={history} onDelete={onDelHistory} />
    </div>
  )
}

// ============================================================
//  BALANCE HISTORY SECTION
// ============================================================
function BalanceHistorySection({ history, onDelete }) {
  const [filterAccountId, setFilterAccountId] = useState('all')

  const accountStats = useMemo(() => {
    const stats = {}
    history.forEach(h => {
      if (!stats[h.accountId]) {
        stats[h.accountId] = {
          accountId:   h.accountId,
          accountName: h.accountName,
          totalProfit: 0,
          updates:     0,
          firstDate:   h.date,
          lastDate:    h.date,
          firstValue:  h.oldValue,
          lastValue:   h.newValue,
        }
      }
      const s = stats[h.accountId]
      s.totalProfit += h.diff
      s.updates     += 1
      if (new Date(h.date) < new Date(s.firstDate)) { s.firstDate = h.date; s.firstValue = h.oldValue }
      if (new Date(h.date) > new Date(s.lastDate))  { s.lastDate  = h.date; s.lastValue  = h.newValue }
    })
    return Object.values(stats).sort((a, b) => b.totalProfit - a.totalProfit)
  }, [history])

  const filtered = useMemo(() => {
    const list = filterAccountId === 'all'
      ? history
      : history.filter(h => String(h.accountId) === String(filterAccountId))
    return [...list].sort((a, b) => new Date(b.date) - new Date(a.date))
  }, [history, filterAccountId])

  const enriched = useMemo(() => {
    const byAccount = {}
    history.forEach(h => {
      if (!byAccount[h.accountId]) byAccount[h.accountId] = []
      byAccount[h.accountId].push(h)
    })
    Object.values(byAccount).forEach(list =>
      list.sort((a, b) => new Date(a.date) - new Date(b.date))
    )

    return filtered.map(h => {
      const list = byAccount[h.accountId]
      const idx  = list.findIndex(e => e.id === h.id)
      const prev = idx > 0 ? list[idx - 1] : null
      const daysSince = prev
        ? Math.round((new Date(h.date) - new Date(prev.date)) / 86400000)
        : null
      return { ...h, daysSince }
    })
  }, [filtered, history])

  if (history.length === 0) {
    return (
      <div className="info-bar" style={{ marginTop: 32, textAlign: 'center', padding: '18px 20px', fontSize: '0.88rem' }}>
        📋 עוד לא נרשמו עדכוני יתרה. לחץ על יתרת חשבון בטבלה למעלה כדי להזין עדכון ראשון ולהתחיל לעקוב אחרי הרווח.
      </div>
    )
  }

  const grandTotal = accountStats.reduce((s, x) => s + x.totalProfit, 0)

  return (
    <div style={{ marginTop: 36 }}>
      <div className="section-header">
        <h2>📈 היסטוריית עדכוני יתרות — מעקב רווחים</h2>
      </div>

      <div className="info-bar">
        כל עדכון יתרה נרשם עם תאריך וזמן. ההפרש בין יתרה חדשה לקודמת = הרווח/הפסד מאז העדכון האחרון. <strong>סה"כ רווח מצטבר: <span style={{ color: grandTotal >= 0 ? 'var(--green)' : 'var(--red)' }}>{grandTotal >= 0 ? '+' : ''}{fmt(grandTotal)}</span></strong>
      </div>

      <div className="cards-grid" style={{ marginBottom: 20 }}>
        {accountStats.map(s => {
          const days     = Math.round((new Date(s.lastDate) - new Date(s.firstDate)) / 86400000)
          const weeks    = days / 7
          const weeklyAvg= weeks > 0 ? s.totalProfit / weeks : 0
          const totalPct = s.firstValue ? (s.totalProfit / s.firstValue) * 100 : 0
          return (
            <div key={s.accountId} className={`card ${s.totalProfit >= 0 ? 'card-green' : 'card-red'}`}>
              <div className="card-label" style={{ fontSize: '0.78rem' }}>{s.accountName}</div>
              <div className="card-value" style={{ color: s.totalProfit >= 0 ? 'var(--green)' : 'var(--red)', fontSize: '1.2rem' }}>
                {s.totalProfit >= 0 ? '+' : ''}{fmt(s.totalProfit)}
              </div>
              <div className="card-sub">
                {s.updates} עדכונים · {totalPct >= 0 ? '+' : ''}{totalPct.toFixed(2)}%
                {weeks > 0 && (
                  <><br />ממוצע: {weeklyAvg >= 0 ? '+' : ''}{fmt(weeklyAvg)} / שבוע</>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.88rem', color: 'var(--subtext)' }}>סינון לפי חשבון:</span>
        <select
          className="setting-input"
          style={{ width: 280 }}
          value={filterAccountId}
          onChange={e => setFilterAccountId(e.target.value)}
        >
          <option value="all">כל החשבונות ({history.length})</option>
          {accountStats.map(s => (
            <option key={s.accountId} value={s.accountId}>
              {s.accountName} ({s.updates})
            </option>
          ))}
        </select>
      </div>

      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>תאריך / שעה</th>
              <th>חשבון</th>
              <th>יתרה קודמת</th>
              <th>יתרה חדשה</th>
              <th>שינוי</th>
              <th>%</th>
              <th>ימים מעדכון קודם</th>
              <th>הערה</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {enriched.map(h => {
              const pct = h.oldValue ? (h.diff / h.oldValue) * 100 : 0
              const d   = new Date(h.date)
              return (
                <tr key={h.id}>
                  <td style={{ whiteSpace: 'nowrap', fontSize: '0.85rem' }}>
                    {fmtDate(d)}
                    <span style={{ color: 'var(--subtext)', marginRight: 6, fontSize: '0.78rem' }}>
                      {d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </td>
                  <td style={{ fontWeight: 500 }}>{h.accountName}</td>
                  <td style={{ color: 'var(--subtext)' }}>{fmt(h.oldValue)}</td>
                  <td style={{ fontWeight: 600 }}>{fmt(h.newValue)}</td>
                  <td className={h.diff >= 0 ? 'bal-positive' : 'bal-negative'} style={{ fontWeight: 600 }}>
                    {h.diff >= 0 ? '+' : ''}{fmt(h.diff)}
                  </td>
                  <td className={pct >= 0 ? 'bal-positive' : 'bal-negative'} style={{ fontSize: '0.85rem' }}>
                    {pct >= 0 ? '+' : ''}{pct.toFixed(3)}%
                  </td>
                  <td style={{ color: 'var(--subtext)', fontSize: '0.85rem' }}>
                    {h.daysSince === null
                      ? <em style={{ color: 'var(--primary)' }}>רישום ראשון</em>
                      : `${h.daysSince} ${h.daysSince === 1 ? 'יום' : 'ימים'}`}
                  </td>
                  <td style={{ color: 'var(--subtext)', fontSize: '0.85rem', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {h.note || '—'}
                  </td>
                  <td>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => { if (window.confirm('למחוק את הרישום? יתרת החשבון הנוכחית לא תשתנה.')) onDelete(h.id) }}
                      title="מחק רישום"
                    >✕</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ============================================================
//  PAYMENTS TAB
// ============================================================
function PaymentsTab({ payCals, totals, baseIdx, onUpdPay, onUpdBase }) {
  const totalBase = payCals.reduce((s, p) => s + p.base, 0)
  const totalIdx  = payCals.reduce((s, p) => s + p.idxAdd, 0)
  const totalCost = totalBase + totalIdx

  return (
    <div>
      <div className="section-header">
        <h2>ניהול תשלומים לדירה</h2>
      </div>

      <div className="info-bar">
        הזן אחוז מדד בעמודה הצהובה (לדוגמה: 10 עבור 10%). הסכומים הסופיים מחושבים אוטומטית. אחרי תשלום בפועל: עדכן יתרות בריכוז כספים ושנה סטטוס ל"שולם" + כבה תחזית.
      </div>

      <div className="totals-row">
        <div className="total-chip">
          <div className="tc-label">יתרה זמינה (מריכוז כספים)</div>
          <div className="tc-value blue">{fmt(totals.available)}</div>
        </div>
        <div className="total-chip">
          <div className="tc-label">עלות בסיסית של הדירה</div>
          <div className="tc-value" style={{ color: 'var(--text)' }}>{fmt(totalBase)}</div>
        </div>
        <div className="total-chip">
          <div className="tc-label">עלות כולל מדד</div>
          <div className="tc-value" style={{ color: 'var(--text)' }}>{fmt(totalCost)}</div>
        </div>
        <div className="total-chip">
          <div className="tc-label">תוספת מדד כוללת</div>
          <div className="tc-value" style={{ color: 'var(--amber)' }}>{fmt(totalIdx)}</div>
        </div>
        <div className="total-chip">
          <div className="tc-label">מדד בסיס (ביום חתימה)</div>
          <div className="tc-value" style={{ color: 'var(--text)' }}>
            <input
              className="setting-input"
              type="text"
              value={baseIdx}
              style={{ width: 100 }}
              onChange={e => onUpdBase(parseNum(e.target.value))}
            />
          </div>
        </div>
      </div>

      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>תאריך תשלום</th>
              <th>סכום בסיס</th>
              <th style={{ background: '#fefce8' }}>% מדד</th>
              <th>תוספת מדד</th>
              <th>סכום סופי</th>
              <th>בתחזית</th>
              <th>סטטוס</th>
              <th>נשאר לדירה</th>
              <th>הערות</th>
            </tr>
          </thead>
          <tbody>
            {payCals.map(p => {
              return (
                <tr key={p.id} style={{ background: p.status === 'שולם' ? '#f0fdf4' : p.balAfter < 0 && p.status === 'עתידי' ? '#fff1f2' : 'white' }}>
                  <td style={{ color: 'var(--subtext)', fontSize: '0.8rem' }}>{p.id}</td>
                  <td><EC value={p.date} formatValue={fmtDate} onChange={v => onUpdPay(p.id, 'date', v)} /></td>
                  <td>{fmt(p.base)}</td>
                  <td style={{ background: '#fefce8' }}>
                    {p.notIndexed ? (
                      <span style={{ color: 'var(--subtext)', fontSize: '0.78rem' }}>לא מוצמד</span>
                    ) : (
                      <EC value={p.idxPct} type="percent" onChange={v => onUpdPay(p.id, 'idxPct', v)} />
                    )}
                  </td>
                  <td style={{ color: p.idxAdd > 0 ? 'var(--amber)' : 'var(--subtext)' }}>
                    {p.idxAdd > 0 ? fmt(p.idxAdd) : '—'}
                  </td>
                  <td style={{ fontWeight: 700 }}>{fmt(p.final)}</td>
                  <td>
                    <label className="toggle">
                      <input type="checkbox" checked={p.inForecast} onChange={e => onUpdPay(p.id, 'inForecast', e.target.checked)} />
                      <span className="toggle-slider" />
                    </label>
                  </td>
                  <td>
                    <select
                      className="editable-input"
                      style={{ width: 90 }}
                      value={p.status}
                      onChange={e => onUpdPay(p.id, 'status', e.target.value)}
                    >
                      <option>עתידי</option>
                      <option>שולם</option>
                    </select>
                  </td>
                  <td style={{ color: 'var(--subtext)' }}>{fmt(p.remAfter)}</td>
                  <td><EC value={p.notes} onChange={v => onUpdPay(p.id, 'notes', v)} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ============================================================
//  EXPENSES TAB
// ============================================================
function ExpensesTab({ expenses, expenseTotal, kinderDeps, elecDeps, elecTariff, creditCards, income, onUpdExp, onAddExp, onDelExp, onUpdKinder, onUpdElec, onUpdElecTariff, onAddCard, onUpdCard, onDelCard, onAddIncome, onUpdIncome, onDelIncome, onCopyMonth }) {
  const kTotal = Object.values(kinderDeps || {}).reduce((s, v) => s + (parseNum(v) || 0), 0)
  // Defensive: support legacy format (number) and new format ({ amount, kwh })
  const getElecRow = (m) => {
    const v = elecDeps?.[m]
    if (!v) return { amount: null, kwh: null }
    if (typeof v === 'object') return v
    return { amount: v, kwh: null }
  }
  const eTotal    = Object.keys(elecDeps || {}).reduce((s, m) => s + (parseNum(getElecRow(m).amount) || 0), 0)
  const eTotalKwh = Object.keys(elecDeps || {}).reduce((s, m) => s + (parseNum(getElecRow(m).kwh)    || 0), 0)

  const [section, setSection] = useState('budget')

  return (
    <div>
      <div className="section-header">
        <h2>הוצאות חודשיות</h2>
      </div>

      <div className="sub-tabs">
        <button
          className={`sub-tab ${section === 'budget' ? 'active' : ''}`}
          onClick={() => setSection('budget')}
        >💳 כרטיסי אשראי + הכנסות</button>
        <button
          className={`sub-tab ${section === 'utilities' ? 'active' : ''}`}
          onClick={() => setSection('utilities')}
        >📅 גן + חשמל</button>
        <button
          className={`sub-tab ${section === 'fixed' ? 'active' : ''}`}
          onClick={() => setSection('fixed')}
        >🏠 הוצאות קבועות</button>
      </div>

      {section === 'budget' && (
        <MonthlyBudgetSection
          creditCards={creditCards}
          income={income}
          onAddCard={onAddCard} onUpdCard={onUpdCard} onDelCard={onDelCard}
          onAddIncome={onAddIncome} onUpdIncome={onUpdIncome} onDelIncome={onDelIncome}
          onCopyMonth={onCopyMonth}
        />
      )}

      {section === 'fixed' && (
        <div>
          <div className="info-bar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <span>רשימת הוצאות שיורדות אוטומטית מהעו"ש בכל חודש (הוראות קבע, מנויים וכו').</span>
            <button className="btn btn-outline btn-sm" onClick={onAddExp}>+ הוסף הוצאה</button>
          </div>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>שם התשלום</th>
                  <th>סכום חודשי</th>
                  <th>סוג</th>
                  <th>הערות</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {expenses.map(e => (
                  <tr key={e.id}>
                    <td><EC value={e.name}   onChange={v => onUpdExp(e.id, 'name', v)} /></td>
                    <td><EC value={e.amount} type="number" onChange={v => onUpdExp(e.id, 'amount', v)} /></td>
                    <td><EC value={e.type}   onChange={v => onUpdExp(e.id, 'type', v)} /></td>
                    <td><EC value={e.notes}  onChange={v => onUpdExp(e.id, 'notes', v)} /></td>
                    <td><button className="btn btn-ghost btn-sm" onClick={() => { if (window.confirm('למחוק?')) onDelExp(e.id) }}>✕</button></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="summary-row">
                  <td>סה"כ הוצאות קבועות</td>
                  <td style={{ color: 'var(--primary)', fontWeight: 700 }}>{fmt(expenseTotal)}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {section === 'utilities' && (
        <div>
          <div className="info-bar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <span>תיעוד חודשי של תשלומי גן + חשמל. <strong>אין השפעה</strong> על יתרות חשבונות בריכוז כספים.</span>
            <div style={{ display: 'flex', gap: 18, fontSize: '0.85rem' }}>
              <span>סה"כ גן: <strong>{fmt(kTotal)}</strong></span>
              <span>סה"כ חשמל: <strong>{fmt(eTotal)}</strong> · {eTotalKwh.toFixed(0)} קוט"ש</span>
            </div>
          </div>

          {/* Electricity tariff setting */}
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.88rem', fontWeight: 600 }}>⚡ תעריף ביתי לקוט"ש:</span>
            <input
              className="setting-input"
              type="text"
              value={elecTariff}
              style={{ width: 90 }}
              onChange={e => onUpdElecTariff(e.target.value)}
            />
            <span style={{ fontSize: '0.78rem', color: 'var(--subtext)' }}>
              ₪ לקוט"ש (כולל מע"מ). עדכן לפי הודעות רשמיות של רשות החשמל.
            </span>
          </div>

          <div className="two-cols">
          {/* Kindergarten */}
          <div className="sub-card">
            <div className="sub-card-header">📅 טבלת גן — חודשית</div>
            <div>
              <table className="mini-table">
                <thead><tr><th>חודש</th><th>סכום הפקדה</th></tr></thead>
                <tbody>
                  {KINDER_MONTHS.map(m => (
                    <tr key={m} style={{ background: kinderDeps[m] ? '#f0fdf4' : 'white' }}>
                      <td style={{ color: 'var(--subtext)' }}>{m}</td>
                      <td>
                        <input
                          className="editable-input"
                          type="text"
                          value={kinderDeps[m] || ''}
                          placeholder="0"
                          style={{ width: '100%' }}
                          onChange={e => onUpdKinder(m, e.target.value)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Electricity */}
          <div className="sub-card">
            <div className="sub-card-header">
              ⚡ טבלת חשמל — דו-חודשית
              <span style={{ fontWeight: 400, color: 'var(--subtext)', fontSize: '0.75rem', marginRight: 6 }}>
                (הזן קוט"ש או סכום — השדה השני יתמלא אוטומטית)
              </span>
            </div>
            <div>
              <table className="mini-table">
                <thead>
                  <tr>
                    <th>חודש</th>
                    <th>קוט"ש (צריכת מונה)</th>
                    <th>סכום ₪</th>
                  </tr>
                </thead>
                <tbody>
                  {ELEC_MONTHS.map(m => {
                    const row = getElecRow(m)
                    const hasData = (row.amount != null && row.amount !== '') || (row.kwh != null && row.kwh !== '')
                    return (
                      <tr key={m} style={{ background: hasData ? '#f0fdf4' : 'white' }}>
                        <td style={{ color: 'var(--subtext)' }}>{m}</td>
                        <td>
                          <input
                            className="editable-input"
                            type="text"
                            value={row.kwh ?? ''}
                            placeholder={'קוט"ש'}
                            style={{ width: '100%' }}
                            onChange={e => onUpdElec(m, 'kwh', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="editable-input"
                            type="text"
                            value={row.amount ?? ''}
                            placeholder="₪"
                            style={{ width: '100%' }}
                            onChange={e => onUpdElec(m, 'amount', e.target.value)}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        </div>
      )}
    </div>
  )
}

// ============================================================
//  MONTHLY BUDGET SECTION  (Credit cards + Income + chart)
// ============================================================
function MonthlyBudgetSection({ creditCards, income, onAddCard, onUpdCard, onDelCard, onAddIncome, onUpdIncome, onDelIncome, onCopyMonth }) {
  const [selectedMonth, setSelectedMonth] = useState(currentMonthKey())

  // Build a sorted list of months that have any data, plus current month, plus last 6
  const monthOptions = useMemo(() => {
    const set = new Set([currentMonthKey(), ...lastNMonths(6)])
    creditCards.forEach(c => set.add(c.month))
    income.forEach(i => set.add(i.month))
    return Array.from(set).sort((a, b) => {
      const [am, ay] = a.split('/'); const [bm, by] = b.split('/')
      return `${by}-${bm}`.localeCompare(`${ay}-${am}`) // newest first
    })
  }, [creditCards, income])

  const monthCards  = creditCards.filter(c => c.month === selectedMonth)
  const monthIncome = income.filter(i => i.month === selectedMonth)

  const cardsTotal  = monthCards.reduce((s, c) => s + (parseNum(c.amount) || 0), 0)
  const incomeTotal = monthIncome.reduce((s, i) => s + (parseNum(i.amount) || 0), 0)
  const net         = incomeTotal - cardsTotal

  // Last 6 months for the chart
  const chartData = useMemo(() => {
    return lastNMonths(6).map(m => {
      const c = creditCards.filter(x => x.month === m).reduce((s, x) => s + (parseNum(x.amount) || 0), 0)
      const i = income.filter(x => x.month === m).reduce((s, x) => s + (parseNum(x.amount) || 0), 0)
      return { month: m, cards: c, income: i, net: i - c }
    })
  }, [creditCards, income])

  const chartMax = Math.max(1, ...chartData.flatMap(d => [d.cards, d.income]))

  return (
    <div style={{ marginTop: 36 }}>
      <div className="section-header">
        <h2>💳 כרטיסי אשראי + הכנסות — מעקב חודשי</h2>
      </div>

      <div className="info-bar">
        בחר חודש, הוסף שורות לכל כרטיס/הכנסה. הגרף למטה משווה 6 חודשים אחרונים.
      </div>

      {/* Month picker */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>חודש פעיל:</span>
        <select
          className="setting-input"
          style={{ width: 140 }}
          value={selectedMonth}
          onChange={e => setSelectedMonth(e.target.value)}
        >
          {monthOptions.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <button
          className="btn btn-outline btn-sm"
          onClick={() => {
            const [mm, yy] = selectedMonth.split('/').map(Number)
            let pm = mm - 1, py = yy
            if (pm < 1) { pm = 12; py-- }
            const prev = `${String(pm).padStart(2,'0')}/${py}`
            const pc = creditCards.filter(c => c.month === prev)
            const pi = income.filter(i => i.month === prev)
            if (pc.length === 0 && pi.length === 0) {
              alert(`אין נתונים בחודש ${prev} להעתקה.`); return
            }
            if (window.confirm(`להעתיק ל-${selectedMonth} מתוך ${prev}:\n• ${pc.length} חיובי אשראי\n• ${pi.length} הכנסות`)) {
              onCopyMonth(prev, selectedMonth)
            }
          }}
          title="מעתיק את כל הרשומות מהחודש הקודם לחודש הפעיל"
        >
          📋 העתק מחודש קודם
        </button>
        <span style={{ fontSize: '0.82rem', color: 'var(--subtext)' }}>
          {selectedMonth === currentMonthKey() && '· זה החודש הנוכחי'}
        </span>
      </div>

      <div className="two-cols">
        {/* Credit cards */}
        <div className="sub-card">
          <div className="sub-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>💳 הוצאות אשראי — {selectedMonth}</span>
            <button className="btn btn-outline btn-sm" onClick={() => onAddCard(selectedMonth)}>+ הוסף חיוב</button>
          </div>
          <table className="mini-table">
            <thead>
              <tr>
                <th>חברה</th>
                <th>4 אחרונות</th>
                <th>סכום</th>
                <th>הערות</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {monthCards.length === 0 ? (
                <tr><td colSpan={5} style={{ textAlign: 'center', padding: 16, color: 'var(--subtext)' }}>אין חיובים לחודש זה. לחץ "+" להוספה.</td></tr>
              ) : monthCards.map(c => (
                <tr key={c.id}>
                  <td>
                    <input
                      className="editable-input"
                      type="text"
                      value={c.company}
                      list="card-companies"
                      style={{ width: 120 }}
                      onChange={e => onUpdCard(c.id, 'company', e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      className="editable-input"
                      type="text"
                      value={c.last4}
                      placeholder="1234"
                      maxLength={4}
                      style={{ width: 70 }}
                      onChange={e => onUpdCard(c.id, 'last4', e.target.value.replace(/\D/g, '').slice(0, 4))}
                    />
                  </td>
                  <td>
                    <input
                      className="editable-input"
                      type="text"
                      value={c.amount}
                      style={{ width: 90 }}
                      onChange={e => onUpdCard(c.id, 'amount', parseNum(e.target.value))}
                    />
                  </td>
                  <td>
                    <input
                      className="editable-input"
                      type="text"
                      value={c.notes || ''}
                      style={{ width: '100%' }}
                      onChange={e => onUpdCard(c.id, 'notes', e.target.value)}
                    />
                  </td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => { if (window.confirm('למחוק?')) onDelCard(c.id) }}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="summary-row">
                <td colSpan={2}>סה"כ אשראי</td>
                <td colSpan={3} style={{ color: 'var(--red)', fontWeight: 700 }}>{fmt(cardsTotal)}</td>
              </tr>
            </tfoot>
          </table>
          <datalist id="card-companies">
            {CARD_COMPANIES.map(c => <option key={c} value={c} />)}
          </datalist>
        </div>

        {/* Income */}
        <div className="sub-card">
          <div className="sub-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>💰 הכנסות — {selectedMonth}</span>
            <button className="btn btn-outline btn-sm" onClick={() => onAddIncome(selectedMonth)}>+ הוסף הכנסה</button>
          </div>
          <table className="mini-table">
            <thead>
              <tr>
                <th>קטגוריה</th>
                <th>סכום</th>
                <th>הערות</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {monthIncome.length === 0 ? (
                <tr><td colSpan={4} style={{ textAlign: 'center', padding: 16, color: 'var(--subtext)' }}>
                  אין הכנסות לחודש זה. <br />
                  <div style={{ marginTop: 8, display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
                    {INCOME_CATEGORIES.map(cat => (
                      <button key={cat} className="btn btn-outline btn-sm" onClick={() => onAddIncome(selectedMonth, cat)} style={{ fontSize: '0.75rem' }}>
                        + {cat}
                      </button>
                    ))}
                  </div>
                </td></tr>
              ) : monthIncome.map(i => (
                <tr key={i.id}>
                  <td>
                    <input
                      className="editable-input"
                      type="text"
                      value={i.category}
                      list="income-categories"
                      style={{ width: 140 }}
                      onChange={e => onUpdIncome(i.id, 'category', e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      className="editable-input"
                      type="text"
                      value={i.amount}
                      style={{ width: 100 }}
                      onChange={e => onUpdIncome(i.id, 'amount', parseNum(e.target.value))}
                    />
                  </td>
                  <td>
                    <input
                      className="editable-input"
                      type="text"
                      value={i.notes || ''}
                      style={{ width: '100%' }}
                      onChange={e => onUpdIncome(i.id, 'notes', e.target.value)}
                    />
                  </td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => { if (window.confirm('למחוק?')) onDelIncome(i.id) }}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="summary-row">
                <td>סה"כ הכנסות</td>
                <td colSpan={3} style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(incomeTotal)}</td>
              </tr>
            </tfoot>
          </table>
          <datalist id="income-categories">
            {INCOME_CATEGORIES.map(c => <option key={c} value={c} />)}
          </datalist>
        </div>
      </div>

      {/* Monthly net summary */}
      <div className="cards-grid" style={{ marginTop: 20 }}>
        <div className="card card-green">
          <div className="card-icon">💰</div>
          <div className="card-label">סה"כ הכנסות {selectedMonth}</div>
          <div className="card-value" style={{ color: 'var(--green)' }}>{fmt(incomeTotal)}</div>
          <div className="card-sub">{monthIncome.length} רישומים</div>
        </div>
        <div className="card card-red">
          <div className="card-icon">💳</div>
          <div className="card-label">סה"כ אשראי {selectedMonth}</div>
          <div className="card-value" style={{ color: 'var(--red)' }}>{fmt(cardsTotal)}</div>
          <div className="card-sub">{monthCards.length} חיובים</div>
        </div>
        <div className={`card ${net >= 0 ? 'card-blue' : 'card-amber'}`}>
          <div className="card-icon">{net >= 0 ? '📈' : '📉'}</div>
          <div className="card-label">{net >= 0 ? 'נותר בסוף החודש' : 'גירעון בחודש'}</div>
          <div className="card-value" style={{ color: net >= 0 ? 'var(--primary)' : 'var(--amber)' }}>
            {net >= 0 ? '+' : ''}{fmt(net)}
          </div>
          <div className="card-sub">הכנסות פחות אשראי</div>
        </div>
      </div>

      {/* 6-month chart */}
      <div className="card" style={{ marginTop: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
          <strong style={{ fontSize: '0.95rem' }}>📊 השוואה — 6 חודשים אחרונים</strong>
          <div style={{ display: 'flex', gap: 14, fontSize: '0.8rem' }}>
            <span><span className="legend-dot" style={{ background: 'var(--green)' }} /> הכנסות</span>
            <span><span className="legend-dot" style={{ background: 'var(--red)' }} /> אשראי</span>
          </div>
        </div>
        <div className="budget-chart">
          {chartData.map(d => {
            const incH  = (d.income / chartMax) * 100
            const cardH = (d.cards  / chartMax) * 100
            return (
              <div key={d.month} className="chart-bar-group">
                <div className="chart-bars">
                  <div className="chart-bar chart-bar-income" style={{ height: `${incH}%` }} title={`הכנסות: ${fmt(d.income)}`}>
                    {d.income > 0 && <span className="chart-bar-value">{Math.round(d.income/1000)}k</span>}
                  </div>
                  <div className="chart-bar chart-bar-cards" style={{ height: `${cardH}%` }} title={`אשראי: ${fmt(d.cards)}`}>
                    {d.cards > 0 && <span className="chart-bar-value">{Math.round(d.cards/1000)}k</span>}
                  </div>
                </div>
                <div className="chart-bar-label">
                  <strong>{d.month}</strong>
                  <span style={{ color: d.net >= 0 ? 'var(--green)' : 'var(--red)', fontSize: '0.72rem' }}>
                    {d.net >= 0 ? '+' : ''}{fmt(d.net)}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ============================================================
//  SAVINGS TAB
// ============================================================
function SavingsTab({ savings, savingsTotal, onEdit }) {
  const entries = SAVING_MONTHS.map(m => {
    const v = savings?.[m]
    const obj = (v && typeof v === 'object') ? v : (v ? { amount: v, destination: '' } : null)
    return { month: m, amount: obj?.amount || null, destination: obj?.destination || '' }
  })
  const withData   = entries.filter(e => e.amount)
  const avgMonthly = withData.length > 0 ? savingsTotal / withData.length : 0

  const rows = entries

  return (
    <div>
      <div className="section-header">
        <h2>חיסכון חודשי מהעובר ושב</h2>
      </div>

      <div className="info-bar">
        לחץ על שורה כדי לעדכן סכום + לאן הועבר. נתון אישי לסדר ומעקב — לא מתעדכן בריכוז הכספים.
      </div>

      <div className="savings-summary">
        <div className="total-chip">
          <div className="tc-label">סה"כ חיסכון שהוזן</div>
          <div className="tc-value green">{fmt(savingsTotal)}</div>
        </div>
        <div className="total-chip">
          <div className="tc-label">ממוצע חודשי</div>
          <div className="tc-value blue">{fmt(avgMonthly)}</div>
        </div>
        <div className="total-chip">
          <div className="tc-label">חודשים שהוזנו</div>
          <div className="tc-value" style={{ color: 'var(--text)' }}>{withData.length}</div>
        </div>
      </div>

      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>חודש</th>
              <th>סכום שנחסך</th>
              <th>יעד (לאן הועבר)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.month} style={{ background: r.amount ? '#f0fdf4' : 'white' }}>
                <td style={{ color: 'var(--subtext)', fontWeight: r.amount ? 600 : 400 }}>{r.month}</td>
                <td>
                  <button
                    className="balance-btn"
                    onClick={() => onEdit(r.month)}
                    title="לחץ לעדכון סכום ויעד"
                  >
                    {r.amount
                      ? <span>{fmt(r.amount)}</span>
                      : <span style={{ color: 'var(--subtext)' }}>+ הזן סכום</span>}
                    <span className="edit-icon">✏️</span>
                  </button>
                </td>
                <td style={{ fontSize: '0.85rem', color: r.destination ? 'var(--text)' : 'var(--subtext)' }}>
                  {r.destination || '—'}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="summary-row">
              <td>סה"כ</td>
              <td>{fmt(savingsTotal)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

// ============================================================
//  INDEX TAB  (מדד תשומות בנייה למגורים)
// ============================================================
function IndexTab({ indexHistory, baseIdx, apiData, apiStatus, onRefresh, onUpdEntry, onDelEntry, onUpdBase }) {
  const [newMonth, setNewMonth] = useState('')
  const [newValue, setNewValue] = useState('')

  // Sort entries chronologically (MM/YYYY → YYYY-MM for comparison)
  const sortKey = (m) => {
    const [mo, yr] = m.split('/')
    return `${yr}-${mo.padStart(2, '0')}`
  }

  // Merge API data with manual entries — manual overrides API for the same month
  const merged = useMemo(() => {
    const map = new Map()
    ;(apiData || []).forEach(({ month, value }) => {
      map.set(month, { month, value, source: 'api' })
    })
    Object.entries(indexHistory || {}).forEach(([month, value]) => {
      if (value !== null && value !== undefined && value !== '') {
        map.set(month, { month, value: parseNum(value), source: 'manual' })
      }
    })
    return Array.from(map.values()).sort((a, b) => sortKey(a.month).localeCompare(sortKey(b.month)))
  }, [apiData, indexHistory])

  // Stats
  const baseValue   = parseNum(baseIdx) || 140.78
  const latest      = merged.length > 0 ? merged[merged.length - 1] : null
  const latestValue = latest ? latest.value : baseValue
  const latestPct   = baseValue > 0 ? ((latestValue - baseValue) / baseValue) * 100 : 0
  const latestDiff  = latestValue - baseValue

  // Compute change from previous entry
  const enriched = merged.map((row, i) => {
    const value = row.value
    const pctFromBase = baseValue > 0 ? ((value - baseValue) / baseValue) * 100 : 0
    const prev = i > 0 ? merged[i - 1].value : null
    const monthlyChange = prev !== null ? value - prev : null
    const monthlyChangePct = prev !== null && prev > 0 ? ((value - prev) / prev) * 100 : null
    return { ...row, pctFromBase, monthlyChange, monthlyChangePct }
  })

  const addEntry = () => {
    if (!newMonth.match(/^\d{2}\/\d{4}$/)) {
      alert('פורמט: MM/YYYY (לדוגמה: 06/2026)')
      return
    }
    if (!newValue || parseNum(newValue) <= 0) {
      alert('הזן ערך מדד חוקי (מספר חיובי)')
      return
    }
    onUpdEntry(newMonth, newValue)
    setNewMonth('')
    setNewValue('')
  }

  // Suggest next month based on latest entry
  const suggestNextMonth = () => {
    if (!latest) return '04/2026'
    const [mo, yr] = latest.month.split('/').map(Number)
    let nm = mo + 1, ny = yr
    if (nm > 12) { nm = 1; ny++ }
    return `${String(nm).padStart(2, '0')}/${ny}`
  }

  // Status text builder
  const statusText = (() => {
    if (apiStatus.status === 'loading')   return '🔄 מתחבר ל-API של הלמ"ס...'
    if (apiStatus.status === 'connected') return `✓ מחובר ל-API הלמ"ס · ${(apiData || []).length} חודשי נתונים`
    if (apiStatus.status === 'error')     return `⚠ נכשל החיבור: ${apiStatus.error}`
    return 'לא נוצר חיבור עדיין'
  })()

  return (
    <div>
      <div className="section-header">
        <h2>מדד תשומות בנייה למגורים</h2>
      </div>

      {/* ============================================================
          API STATUS INDICATOR  ← מחוון סטטוס ה-API
          ────────────────────────────────────────────────────────────
          מציג חיווי מחובר/בטעינה/שגיאה לחיבור עם ה-API של הלמ"ס.
          כולל כפתור רענון ידני וזמן עדכון אחרון.
          הנתונים נשלפים מ-api.cbs.gov.il (סדרה {CBS_BUILDING_INDEX_ID}).
          ============================================================ */}
      <div className={`api-status-card api-${apiStatus.status}`}>
        <div className="api-status-indicator">
          <span className={`api-dot api-dot-${apiStatus.status}`} aria-hidden="true" />
          <span className="api-status-text">
            <strong>{statusText}</strong>
            {apiStatus.lastFetch && (
              <span className="api-status-meta">
                · עודכן {fmtDate(apiStatus.lastFetch)} בשעה {new Date(apiStatus.lastFetch).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </span>
        </div>
        <button
          className="btn btn-outline btn-sm"
          onClick={onRefresh}
          disabled={apiStatus.status === 'loading'}
          title={'שלוף שוב את הנתונים מ-API הלמ"ס'}
        >
          🔄 רענן
        </button>
      </div>

      <div className="info-bar">
        ערכי המדד נשלפים אוטומטית מ-API של הלמ"ס ב-{CBS_FETCH_MONTHS} החודשים האחרונים. <strong>ערכים ידניים שתזין גוברים</strong> על נתוני ה-API לאותו חודש (מסומנים כ"ידני" בעמודת המקור).
      </div>

      {/* Summary cards */}
      <div className="cards-grid" style={{ marginBottom: 24 }}>
        <div className="card card-blue">
          <div className="card-icon">📌</div>
          <div className="card-label">מדד בסיס (ביום חתימת החוזה)</div>
          <div className="card-value" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              className="setting-input"
              type="text"
              value={baseIdx}
              style={{ width: 100, fontSize: '1.2rem', fontWeight: 700 }}
              onChange={e => onUpdBase(parseNum(e.target.value))}
            />
            <span style={{ fontSize: '0.85rem', color: 'var(--subtext)' }}>נק'</span>
          </div>
          <div className="card-sub">ערך התחלתי - שאר החישובים נשענים עליו</div>
        </div>

        <div className="card card-amber">
          <div className="card-icon">📈</div>
          <div className="card-label">מדד אחרון</div>
          <div className="card-value">
            {latestValue.toFixed(2)}
            {latest && <span style={{ fontSize: '0.85rem', color: 'var(--subtext)', marginRight: 6 }}>({latest.month})</span>}
          </div>
          <div className="card-sub" style={{ color: latestPct >= 0 ? 'var(--amber)' : 'var(--green)' }}>
            {latestPct >= 0 ? '⬆' : '⬇'} {latestPct.toFixed(4)}% ({latestDiff >= 0 ? '+' : ''}{latestDiff.toFixed(2)} נק')
          </div>
        </div>

        <div className="card card-purple">
          <div className="card-icon">📊</div>
          <div className="card-label">חודשים זמינים</div>
          <div className="card-value">{merged.length}</div>
          <div className="card-sub">{(apiData || []).length} מ-API · {merged.filter(m => m.source === 'manual').length} ידניים</div>
        </div>

        <div className="card card-teal">
          <div className="card-icon">💡</div>
          <div className="card-label">להעתקה לתשלום</div>
          <div className="card-value" style={{ fontSize: '1.5rem', color: 'var(--primary)' }}>
            {latestPct.toFixed(4)}%
          </div>
          <div className="card-sub">לחץ והעתק לטבלת תשלומים</div>
        </div>
      </div>

      {/* Add new entry */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: '0.82rem', color: 'var(--subtext)', marginBottom: 4 }}>חודש (MM/YYYY)</div>
            <input
              className="setting-input"
              type="text"
              placeholder={suggestNextMonth()}
              value={newMonth}
              onChange={e => setNewMonth(e.target.value)}
              onFocus={() => !newMonth && setNewMonth(suggestNextMonth())}
              style={{ width: 130 }}
            />
          </div>
          <div>
            <div style={{ fontSize: '0.82rem', color: 'var(--subtext)', marginBottom: 4 }}>ערך מדד</div>
            <input
              className="setting-input"
              type="text"
              placeholder="141.50"
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addEntry()}
              style={{ width: 130 }}
            />
          </div>
          <button className="btn btn-primary" onClick={addEntry} style={{ background: 'var(--primary)' }}>+ הוסף רישום</button>
          <div style={{ flex: 1, minWidth: 200, color: 'var(--subtext)', fontSize: '0.82rem', alignSelf: 'center' }}>
            💡 ערכי המדד מתפרסמים על ידי הלמ"ס סביב ה-15 לכל חודש
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>חודש</th>
              <th>מקור</th>
              <th style={{ background: '#fefce8' }}>ערך מדד</th>
              <th>שינוי מהחודש הקודם</th>
              <th>שינוי % מהבסיס</th>
              <th>תוספת מדד על תשלום של 144,545 ₪</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {enriched.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: 30, color: 'var(--subtext)' }}>
                  עדיין אין נתוני מדד — נסה לרענן את ה-API למעלה או הוסף ידנית.
                </td>
              </tr>
            ) : enriched.map((row, i) => {
              const baseExample = 144545 * row.pctFromBase / 100
              const isLast      = i === enriched.length - 1
              return (
                <tr key={row.month} style={{ background: isLast ? '#f0f7ff' : 'white' }}>
                  <td style={{ fontWeight: isLast ? 700 : 500 }}>
                    {row.month}
                    {isLast && <span style={{ marginRight: 8, fontSize: '0.7rem', color: 'var(--primary)' }}>🔵 אחרון</span>}
                  </td>
                  <td>
                    {row.source === 'api' ? (
                      <span className="badge" style={{ background: 'var(--primary-pale)', color: 'var(--primary)' }}>🌐 API</span>
                    ) : (
                      <span className="badge" style={{ background: 'var(--amber-light)', color: 'var(--amber)' }}>✏️ ידני</span>
                    )}
                  </td>
                  <td style={{ background: '#fefce8' }}>
                    <input
                      className="editable-input"
                      type="text"
                      value={row.value}
                      style={{ width: 100, fontWeight: 600 }}
                      onChange={e => onUpdEntry(row.month, e.target.value)}
                    />
                  </td>
                  <td>
                    {row.monthlyChange === null ? (
                      <span style={{ color: 'var(--subtext)' }}>—</span>
                    ) : (
                      <span style={{ color: row.monthlyChange >= 0 ? 'var(--amber)' : 'var(--green)' }}>
                        {row.monthlyChange >= 0 ? '+' : ''}{row.monthlyChange.toFixed(2)} נק'
                        <span style={{ fontSize: '0.78rem', marginRight: 6, color: 'var(--subtext)' }}>
                          ({row.monthlyChangePct >= 0 ? '+' : ''}{row.monthlyChangePct.toFixed(3)}%)
                        </span>
                      </span>
                    )}
                  </td>
                  <td style={{ fontWeight: 600, color: row.pctFromBase >= 0 ? 'var(--amber)' : 'var(--green)' }}>
                    {row.pctFromBase >= 0 ? '+' : ''}{row.pctFromBase.toFixed(4)}%
                  </td>
                  <td style={{ color: baseExample >= 0 ? 'var(--amber)' : 'var(--green)' }}>
                    {baseExample >= 0 ? '+' : ''}{fmt(baseExample)}
                  </td>
                  <td>
                    {row.source === 'manual' && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => { if (window.confirm(`למחוק את הערך הידני של ${row.month}? אם קיים ערך מ-API לאותו חודש, הוא ייטען במקומו.`)) onDelEntry(row.month) }}
                        title="מחק רישום ידני"
                      >✕</button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Help section */}
      <div className="card" style={{ marginTop: 20, background: '#fafbfc' }}>
        <div style={{ fontSize: '0.88rem' }}>
          <strong style={{ color: 'var(--primary)' }}>איך משתמשים בערכים האלה?</strong>
          <ul style={{ marginTop: 8, paddingRight: 20, lineHeight: 1.8, color: 'var(--subtext)', fontSize: '0.85rem' }}>
            <li>בכל פעם שמתפרסם מדד חדש (~15 לחודש) — הזן אותו כאן</li>
            <li>המערכת תחשב אוטומטית את האחוז מעל מדד הבסיס ({baseValue.toFixed(2)})</li>
            <li>לפני תשלום עתידי: העתק את האחוז (מהכרטיס הירוק למעלה) לטבלת התשלומים בעמודה "% מדד"</li>
            <li>הקבלן ידרוש <strong>בפועל</strong> סכום שונה — תוכל להזין את ההפרש בפועל ולחשב את האחוז המדויק חזרה (סכום_שדרשו / סכום_בסיס × 100 - 100)</li>
          </ul>
        </div>
      </div>
    </div>
  )
}

// ============================================================
//  MORTGAGE TAB
// ============================================================
const MORTGAGE_PRESETS = {
  solidi: {
    label: '🛡️ סולידי',
    desc:  'רוב קבוע — תשלום יציב, פחות סיכון',
    allocations: { fixed_unlinked: 50, fixed_linked: 30, variable_unlinked_5: 0, variable_linked_5: 0, prime: 20 },
  },
  balanced: {
    label: '⚖️ מאוזן',
    desc:  'שילוב סטנדרטי — שליש קבוע, שליש משתנה, שליש פריים',
    allocations: { fixed_unlinked: 33, fixed_linked: 0, variable_unlinked_5: 0, variable_linked_5: 33, prime: 34 },
  },
  aggressive: {
    label: '🚀 אגרסיבי',
    desc:  'דגש על פריים — תשלום נמוך כיום, סיכון לעליית ריבית',
    allocations: { fixed_unlinked: 25, fixed_linked: 0, variable_unlinked_5: 25, variable_linked_5: 0, prime: 50 },
  },
  short: {
    label: '⚡ קצר טווח',
    desc:  '15 שנה — תשלום חודשי גבוה, סך ריבית נמוך',
    allocations: { fixed_unlinked: 50, fixed_linked: 20, variable_unlinked_5: 0, variable_linked_5: 0, prime: 30 },
    years: 15,
  },
  long: {
    label: '🐢 ארוך טווח',
    desc:  '30 שנה — תשלום חודשי נמוך, סך ריבית גבוה',
    allocations: { fixed_unlinked: 33, fixed_linked: 0, variable_unlinked_5: 0, variable_linked_5: 33, prime: 34 },
    years: 30,
  },
}

function MortgageTab({ mortgage, totals, payCals, onUpd }) {
  const [comparePreset, setComparePreset] = useState(null)

  const totalCost     = payCals.reduce((s, p) => s + p.final, 0)
  const remainingPay  = payCals.filter(p => p.status === 'עתידי').reduce((s, p) => s + p.final, 0)
  const gap           = Math.max(0, remainingPay - totals.available)
  const suggestedAmt  = Math.round(gap)
  const amount        = mortgage.amountOverride != null ? mortgage.amountOverride : suggestedAmt
  const years         = mortgage.years || 25

  const computeMix = (tracks, mortgageAmount, mortgageYears, cpi) => {
    let totalMonthly  = 0
    let totalInterest = 0
    let totalToPay    = 0
    const rows = tracks.map(t => {
      const alloc = parseNum(t.allocation)
      const principal = mortgageAmount * (alloc / 100)
      const monthly   = monthlyPayment(principal, t.rate, mortgageYears)
      const totalPay  = monthly * mortgageYears * 12
      const cpiAdd    = t.cpiLinked ? principal * (Math.pow(1 + cpi/100, mortgageYears) - 1) : 0
      const interest  = totalPay - principal + cpiAdd
      const finalTotalPay = totalPay + cpiAdd
      totalMonthly  += monthly
      totalInterest += interest
      totalToPay    += finalTotalPay
      return { ...t, principal, monthly, totalPay: finalTotalPay, interest, cpiAdd }
    })
    return { rows, totalMonthly, totalInterest, totalToPay }
  }

  const mix = computeMix(mortgage.tracks, amount, years, mortgage.cpiAssumption || 0)

  const updTrack = (id, field, value) => {
    onUpd({
      tracks: mortgage.tracks.map(t =>
        t.id === id ? { ...t, [field]: field === 'allocation' || field === 'rate' ? parseNum(value) : value } : t
      ),
    })
  }

  const applyPreset = (key) => {
    const preset = MORTGAGE_PRESETS[key]
    onUpd({
      tracks: mortgage.tracks.map(t => ({
        ...t,
        allocation: preset.allocations[t.id] ?? 0,
      })),
      ...(preset.years ? { years: preset.years } : {}),
    })
  }

  const totalAlloc = mix.rows.reduce((s, r) => s + parseNum(r.allocation), 0)
  const allocOk    = Math.abs(totalAlloc - 100) < 0.01

  // For preset comparison
  const presetComparisons = Object.entries(MORTGAGE_PRESETS).map(([key, p]) => {
    const tempTracks = mortgage.tracks.map(t => ({ ...t, allocation: p.allocations[t.id] ?? 0 }))
    const yr = p.years || years
    const r = computeMix(tempTracks, amount, yr, mortgage.cpiAssumption || 0)
    return { key, label: p.label, desc: p.desc, years: yr, ...r }
  })

  return (
    <div>
      <div className="section-header">
        <h2>🏛️ ניהול משכנתא — בניית תמהיל</h2>
      </div>

      <div className="info-bar">
        💡 המערכת מציעה את <strong>{fmt(suggestedAmt)}</strong> כסכום משכנתא נדרש, מבוסס על הפער: נדרש לתשלומים עתידיים פחות זמין. ניתן לשנות ידנית.
      </div>

      {/* Top cards */}
      <div className="cards-grid" style={{ marginBottom: 20 }}>
        <div className="card card-purple">
          <div className="card-icon">🏠</div>
          <div className="card-label">עלות דירה כוללת</div>
          <div className="card-value">{fmt(totalCost)}</div>
        </div>
        <div className="card card-green">
          <div className="card-icon">💰</div>
          <div className="card-label">הון עצמי זמין</div>
          <div className="card-value">{fmt(totals.available)}</div>
        </div>
        <div className="card card-amber">
          <div className="card-icon">📉</div>
          <div className="card-label">נשאר לתשלום</div>
          <div className="card-value">{fmt(remainingPay)}</div>
        </div>
        <div className="card card-red">
          <div className="card-icon">🏛️</div>
          <div className="card-label">פער — משכנתא נדרשת</div>
          <div className="card-value" style={{ color: 'var(--red)' }}>{fmt(gap)}</div>
        </div>
      </div>

      {/* Settings */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="setting-row">
          <span className="setting-label">סכום משכנתא (₪)
            <br /><span className="setting-sub">ניתן לעדכן ידנית או להחזיר לערך המוצע ({fmt(suggestedAmt)})</span>
          </span>
          <input
            className="setting-input"
            type="text"
            value={amount}
            style={{ width: 160 }}
            onChange={e => onUpd({ amountOverride: parseNum(e.target.value) })}
          />
          {mortgage.amountOverride != null && (
            <button className="btn btn-ghost btn-sm" onClick={() => onUpd({ amountOverride: null })} title="חזרה לערך המוצע">⟲</button>
          )}
        </div>
        <div className="setting-row">
          <span className="setting-label">תקופת ההלוואה (שנים)</span>
          <select
            className="setting-input"
            style={{ width: 100 }}
            value={years}
            onChange={e => onUpd({ years: Number(e.target.value) })}
          >
            {[10, 12, 15, 18, 20, 22, 25, 27, 30].map(y => (
              <option key={y} value={y}>{y} שנים</option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <span className="setting-label">הנחת אינפלציה שנתית (%)
            <br /><span className="setting-sub">משפיע על מסלולים צמודים למדד</span>
          </span>
          <input
            className="setting-input"
            type="text"
            value={mortgage.cpiAssumption ?? 3}
            style={{ width: 100 }}
            onChange={e => onUpd({ cpiAssumption: parseNum(e.target.value) })}
          />
        </div>
      </div>

      {/* Presets */}
      <div style={{ marginBottom: 12, fontWeight: 600, fontSize: '0.95rem', color: 'var(--primary)' }}>
        תמהילים מוכנים — לחץ כדי להחיל:
      </div>
      <div className="preset-row">
        {Object.entries(MORTGAGE_PRESETS).map(([key, p]) => (
          <button key={key} className="preset-btn" onClick={() => applyPreset(key)}>
            <strong>{p.label}</strong>
            <span>{p.desc}</span>
          </button>
        ))}
      </div>

      {/* Tracks configuration */}
      <div className="table-wrapper" style={{ marginTop: 24 }}>
        <table>
          <thead>
            <tr>
              <th>מסלול</th>
              <th>אחוז</th>
              <th>סכום</th>
              <th>ריבית %</th>
              <th>תשלום חודשי</th>
              <th>סך ריבית לתקופה</th>
              <th>סך לתשלום</th>
            </tr>
          </thead>
          <tbody>
            {mix.rows.map(r => (
              <tr key={r.id} style={{ opacity: r.allocation > 0 ? 1 : 0.45 }}>
                <td>
                  <div style={{ fontWeight: 600 }}>
                    {r.name}
                    {r.cpiLinked && <span className="badge" style={{ background: 'var(--amber-light)', color: 'var(--amber)', marginRight: 6 }}>צמוד</span>}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--subtext)', marginTop: 2 }}>{r.hint}</div>
                </td>
                <td>
                  <input
                    className="editable-input"
                    type="text"
                    value={r.allocation}
                    style={{ width: 60 }}
                    onChange={e => updTrack(r.id, 'allocation', e.target.value)}
                  />
                </td>
                <td style={{ color: r.allocation > 0 ? 'var(--text)' : 'var(--subtext)' }}>{fmt(r.principal)}</td>
                <td>
                  <input
                    className="editable-input"
                    type="text"
                    value={r.rate}
                    style={{ width: 70 }}
                    onChange={e => updTrack(r.id, 'rate', e.target.value)}
                  />
                </td>
                <td style={{ fontWeight: 600 }}>{fmt(r.monthly)}</td>
                <td style={{ color: 'var(--amber)' }}>{fmt(r.interest)}</td>
                <td style={{ fontWeight: 600 }}>{fmt(r.totalPay)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="summary-row">
              <td>סה"כ</td>
              <td className={allocOk ? 'bal-positive' : 'bal-negative'} style={{ fontWeight: 700 }}>
                {totalAlloc.toFixed(0)}%
                {!allocOk && <span style={{ fontSize: '0.72rem', display: 'block' }}>⚠️ חייב 100%</span>}
              </td>
              <td>{fmt(amount)}</td>
              <td>—</td>
              <td style={{ color: 'var(--primary)', fontSize: '1.05rem' }}>{fmt(mix.totalMonthly)}</td>
              <td style={{ color: 'var(--amber)' }}>{fmt(mix.totalInterest)}</td>
              <td style={{ color: 'var(--primary)', fontSize: '1.05rem' }}>{fmt(mix.totalToPay)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Summary cards */}
      <div className="cards-grid" style={{ marginTop: 24 }}>
        <div className="card card-blue">
          <div className="card-icon">💵</div>
          <div className="card-label">תשלום חודשי</div>
          <div className="card-value">{fmt(mix.totalMonthly)}</div>
          <div className="card-sub">למשך {years} שנים = {years * 12} תשלומים</div>
        </div>
        <div className="card card-amber">
          <div className="card-icon">💸</div>
          <div className="card-label">סך ריבית שתשולם</div>
          <div className="card-value" style={{ color: 'var(--amber)' }}>{fmt(mix.totalInterest)}</div>
          <div className="card-sub">{((mix.totalInterest / amount) * 100).toFixed(1)}% מהקרן</div>
        </div>
        <div className="card card-purple">
          <div className="card-icon">📊</div>
          <div className="card-label">סך לתשלום (כולל ריבית ומדד)</div>
          <div className="card-value">{fmt(mix.totalToPay)}</div>
          <div className="card-sub">קרן: {fmt(amount)}</div>
        </div>
      </div>

      {/* Comparison table */}
      <div className="section-header" style={{ marginTop: 36 }}>
        <h2>השוואת תמהילים מוכנים</h2>
      </div>
      <div className="info-bar">
        השוואה צד-לצד של כל התמהילים על אותו סכום ({fmt(amount)}) — כדי לבחור את ההתאמה הנכונה לך.
      </div>
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>תמהיל</th>
              <th>תקופה</th>
              <th>תשלום חודשי</th>
              <th>סך ריבית</th>
              <th>סך לתשלום</th>
              <th>הפרש מהמינימום</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              const minTotal = Math.min(...presetComparisons.map(p => p.totalToPay))
              return presetComparisons.map(p => (
                <tr key={p.key} style={{ background: p.totalToPay === minTotal ? '#f0fdf4' : 'white' }}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{p.label}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--subtext)' }}>{p.desc}</div>
                  </td>
                  <td>{p.years} שנים</td>
                  <td style={{ fontWeight: 600 }}>{fmt(p.totalMonthly)}</td>
                  <td style={{ color: 'var(--amber)' }}>{fmt(p.totalInterest)}</td>
                  <td style={{ fontWeight: 600 }}>{fmt(p.totalToPay)}</td>
                  <td className={p.totalToPay === minTotal ? 'bal-positive' : 'bal-warn'} style={{ fontSize: '0.85rem' }}>
                    {p.totalToPay === minTotal ? '✓ הזול ביותר' : `+${fmt(p.totalToPay - minTotal)}`}
                  </td>
                  <td>
                    <button className="btn btn-outline btn-sm" onClick={() => applyPreset(p.key)}>החל</button>
                  </td>
                </tr>
              ))
            })()}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginTop: 24, background: '#fffbeb', borderRight: '4px solid var(--amber)' }}>
        <div style={{ fontSize: '0.88rem' }}>
          <strong style={{ color: 'var(--amber)' }}>⚠️ דגשים חשובים:</strong>
          <ul style={{ marginTop: 8, paddingRight: 20, lineHeight: 1.7, color: 'var(--text)', fontSize: '0.85rem' }}>
            <li><strong>חישוב מקורב:</strong> חישובי המדד צפויים — בפועל המדד יכול להיות גבוה/נמוך יותר. הריביות הן הצעה ולא קביעה</li>
            <li><strong>תקנת בנק ישראל:</strong> לפחות שליש בקבועה (צמודה או לא), עד שליש בפריים</li>
            <li><strong>תמהיל פריים גבוה:</strong> ריבית הפריים תלויה בריבית בנק ישראל — סיכון לעליה משמעותית</li>
            <li><strong>צמוד למדד:</strong> הקרן עצמה גדלה עם המדד, לא רק הריבית</li>
            <li><strong>הצע לבנק מספר תמהילים:</strong> כל בנק יציע ריביות שונות, השווה לפני חתימה</li>
            <li><strong>תמיד התייעץ עם יועץ משכנתאות</strong> לפני החלטה סופית</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
