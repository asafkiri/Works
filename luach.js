/* לוח שנה עברי, מועדים וזמני שבת — מחושב במכשיר, בלי שירות חיצוני ובלי ספרייה.
 * הכל אריתמטיקה טהורה: המרת תאריכים לפי מחזור הלוח העברי, ומיקום השמש לפי
 * נוסחאות NOAA. אין קריאות רשת, אין מפתחות ואין המתנה — הלוח נפתח מיד גם במטוס.
 *
 * הזמנים מחושבים ללוח ישראל (יום טוב אחד): כניסת שבת/חג 20 דקות לפני השקיעה
 * (מעוגל למטה, לצד המחמיר), ויציאה בצאת הכוכבים 8.5° מתחת לאופק (מעוגל לדקה
 * הקרובה). ברירת המחדל היא קריית גת; אפשר להעביר מקום אחר לכל קריאה.
 *
 * תאריך עברי מוצג לפי המקובל בכל לוח: היום האזרחי נושא את התאריך העברי שיומו
 * חל בו, כלומר זה שהתחיל בשקיעה הקודמת.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Luach = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DAY_MS = 86400000;
  const RD_1970 = 719163;          // מספר היום המוחלט (RD) של 1970-01-01
  const MIN_MS = 60000;

  /* ============================================================
     1. תאריך אזרחי ⇄ מספר יום מוחלט (RD)
     ============================================================ */

  function isGregLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
  const GREG_MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  function gregMonthLength(y, m) { return m === 2 && isGregLeap(y) ? 29 : GREG_MONTH_DAYS[m - 1]; }

  function gregToRd(y, m, d) {
    const p = y - 1;
    return 365 * p + Math.floor(p / 4) - Math.floor(p / 100) + Math.floor(p / 400)
      + Math.floor((367 * m - 362) / 12)
      + (m <= 2 ? 0 : (isGregLeap(y) ? -1 : -2))
      + d;
  }

  function rdToGreg(rd) {
    const d0 = rd - 1;
    const n400 = Math.floor(d0 / 146097), r400 = d0 - 146097 * n400;
    const n100 = Math.floor(r400 / 36524), r100 = r400 - 36524 * n100;
    const n4 = Math.floor(r100 / 1461), r4 = r100 - 1461 * n4;
    const n1 = Math.floor(r4 / 365);
    const y = 400 * n400 + 100 * n100 + 4 * n4 + n1 + ((n100 === 4 || n1 === 4) ? 0 : 1);
    let rest = rd - gregToRd(y, 1, 1);
    let m = 1;
    while (rest >= gregMonthLength(y, m)) { rest -= gregMonthLength(y, m); m++; }
    return { y: y, m: m, d: rest + 1 };
  }

  // RD 1 הוא יום שני, ולכן שארית החלוקה ב-7 נותנת ישירות 0=ראשון.
  function dowOfRd(rd) { return ((rd % 7) + 7) % 7; }

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function isoOfRd(rd) { const g = rdToGreg(rd); return g.y + "-" + pad2(g.m) + "-" + pad2(g.d); }

  function rdOfIso(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > gregMonthLength(y, mo)) return null;
    return gregToRd(y, mo, d);
  }

  /* ============================================================
     2. הלוח העברי
     חודשים: 1=ניסן … 6=אלול, 7=תשרי … 11=שבט, 12=אדר (או אדר א׳), 13=אדר ב׳.
     סדר החודשים בתוך שנה עברית: תשרי…אדר ואז ניסן…אלול.
     ============================================================ */

  const HEB_EPOCH = -1373427;      // ה-RD של א׳ בתשרי שנת א׳

  function hebLeap(y) { return ((y * 7 + 1) % 19) < 7; }
  function hebMonthsInYear(y) { return hebLeap(y) ? 13 : 12; }

  // מספר הימים שחלפו עד המולד של תשרי, כולל דחיית "לא אד״ו ראש".
  function hebElapsedDays(y) {
    const monthsElapsed = Math.floor((235 * y - 234) / 19);
    const partsElapsed = 12084 + 13753 * monthsElapsed;
    let day = monthsElapsed * 29 + Math.floor(partsElapsed / 25920);
    if (((3 * (day + 1)) % 7) < 3) day += 1;
    return day;
  }

  function hebYearCorrection(y) {
    const last = hebElapsedDays(y - 1), present = hebElapsedDays(y), next = hebElapsedDays(y + 1);
    if (next - present === 356) return 2;
    if (present - last === 382) return 1;
    return 0;
  }

  const newYearCache = new Map();
  function hebNewYearRd(y) {
    let v = newYearCache.get(y);
    if (v === undefined) {
      v = HEB_EPOCH + hebElapsedDays(y) + hebYearCorrection(y);
      newYearCache.set(y, v);
    }
    return v;
  }

  function hebYearDays(y) { return hebNewYearRd(y + 1) - hebNewYearRd(y); }

  function hebMonthLength(y, m) {
    if (m === 2 || m === 4 || m === 6 || m === 10 || m === 13) return 29;
    if (m === 12 && !hebLeap(y)) return 29;
    if (m === 8 && hebYearDays(y) % 10 !== 5) return 29;   // חשוון מלא רק בשנה שלמה
    if (m === 9 && hebYearDays(y) % 10 === 3) return 29;   // כסלו חסר בשנה חסרה
    return 30;
  }

  function hebToRd(y, m, d) {
    let rd = hebNewYearRd(y) + d - 1;
    if (m < 7) {
      const last = hebMonthsInYear(y);
      for (let mm = 7; mm <= last; mm++) rd += hebMonthLength(y, mm);
      for (let mm = 1; mm < m; mm++) rd += hebMonthLength(y, mm);
    } else {
      for (let mm = 7; mm < m; mm++) rd += hebMonthLength(y, mm);
    }
    return rd;
  }

  function rdToHeb(rd) {
    let y = Math.floor((rd - HEB_EPOCH) / 366) + 1;
    while (hebNewYearRd(y + 1) <= rd) y++;
    let m = (rd < hebToRd(y, 1, 1)) ? 7 : 1;
    while (rd > hebToRd(y, m, hebMonthLength(y, m))) m++;
    return { y: y, m: m, d: rd - hebToRd(y, m, 1) + 1 };
  }

  /* ---------- שמות חודשים וגימטריה ---------- */

  const HEB_MONTH_NAMES = {
    1: "ניסן", 2: "אייר", 3: "סיוון", 4: "תמוז", 5: "אב", 6: "אלול",
    7: "תשרי", 8: "חשוון", 9: "כסלו", 10: "טבת", 11: "שבט", 12: "אדר", 13: "אדר ב׳"
  };
  function hebMonthName(y, m) {
    if (m === 12 && hebLeap(y)) return "אדר א׳";
    return HEB_MONTH_NAMES[m];
  }

  const GEM_ONES = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
  const GEM_TENS = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];
  const GEM_HUNDREDS = ["", "ק", "ר", "ש", "ת"];

  function gematriaLetters(n) {
    let out = "", h = Math.floor(n / 100), rest = n % 100;
    while (h >= 4) { out += "ת"; h -= 4; }
    out += GEM_HUNDREDS[h];
    // ט״ו וט״ז ולא י״ה/י״ו, מפני שמות הקודש.
    if (rest === 15) return out + "טו";
    if (rest === 16) return out + "טז";
    out += GEM_TENS[Math.floor(rest / 10)];
    out += GEM_ONES[rest % 10];
    return out;
  }

  function gematria(n) {
    const s = gematriaLetters(n);
    if (!s) return "";
    if (s.length === 1) return s + "׳";
    return s.slice(0, -1) + "״" + s.slice(-1);
  }

  function hebrewFromRd(rd) {
    const h = rdToHeb(rd);
    const monthName = hebMonthName(h.y, h.m);
    const dayLabel = gematria(h.d);
    const yearLabel = gematria(h.y % 1000);
    return {
      y: h.y, m: h.m, d: h.d,
      monthName: monthName,
      dayLabel: dayLabel,
      yearLabel: yearLabel,
      label: dayLabel + " ב" + monthName + " " + yearLabel,
      isLeap: hebLeap(h.y)
    };
  }

  /* ============================================================
     3. פרשת השבוע — מחזור הקריאה בישראל
     ============================================================ */

  const PARSHIYOT = [
    "בראשית", "נח", "לך לך", "וירא", "חיי שרה", "תולדות", "ויצא", "וישלח", "וישב",
    "מקץ", "ויגש", "ויחי", "שמות", "וארא", "בא", "בשלח", "יתרו", "משפטים", "תרומה",
    "תצוה", "כי תשא", "ויקהל", "פקודי", "ויקרא", "צו", "שמיני", "תזריע", "מצורע",
    "אחרי מות", "קדושים", "אמור", "בהר", "בחוקותי", "במדבר", "נשא", "בהעלותך",
    "שלח לך", "קרח", "חוקת", "בלק", "פינחס", "מטות", "מסעי", "דברים", "ואתחנן",
    "עקב", "ראה", "שופטים", "כי תצא", "כי תבוא", "ניצבים", "וילך", "האזינו",
    "וזאת הברכה"
  ];

  // מקף עברי מחבר שתי פרשות. הוא גם הטיפוגרפיה הנכונה בעברית וגם נקודת
  // שבירת שורה תקנית, כך ש"ויקהל־פקודי" נשבר אחרי המקף בתא צר של לוח.
  const PAIR_SEPARATOR = "\u05be";

  // שבע צמדי הפרשות הניתנות לחיבור, לפי אינדקס הפרשה הראשונה בצמד.
  const PAIR_VP = 21, PAIR_TM = 26, PAIR_AK = 28, PAIR_BB = 31,
    PAIR_CB = 38, PAIR_MM = 41, PAIR_NV = 50;

  // אילו צמדים מחוברים — נקבע במלואו בידי טיפוס השנה:
  // יום בשבוע של א׳ בתשרי | פשוטה/מעוברת | אורך השנה בימים.
  const SEDRA_COMBINED = {
    "1|-|353": [PAIR_VP, PAIR_TM, PAIR_AK, PAIR_BB, PAIR_MM, PAIR_NV],
    "1|-|355": [PAIR_VP, PAIR_TM, PAIR_AK, PAIR_BB, PAIR_MM, PAIR_NV],
    "1|L|383": [PAIR_MM, PAIR_NV],
    "1|L|385": [],
    "2|-|354": [PAIR_VP, PAIR_TM, PAIR_AK, PAIR_BB, PAIR_MM, PAIR_NV],
    "2|L|384": [],
    "4|-|354": [PAIR_VP, PAIR_TM, PAIR_AK, PAIR_MM],
    "4|-|355": [PAIR_TM, PAIR_AK, PAIR_BB, PAIR_MM],
    "4|L|383": [],
    "4|L|385": [PAIR_NV],
    "6|-|353": [PAIR_VP, PAIR_TM, PAIR_AK, PAIR_BB, PAIR_MM],
    "6|-|355": [PAIR_VP, PAIR_TM, PAIR_AK, PAIR_BB, PAIR_MM, PAIR_NV],
    "6|L|383": [PAIR_MM, PAIR_NV],
    "6|L|385": [PAIR_MM, PAIR_NV]
  };

  function sedraYearKey(hy) {
    return dowOfRd(hebNewYearRd(hy)) + "|" + (hebLeap(hy) ? "L" : "-") + "|" + hebYearDays(hy);
  }

  // בשבתות שהן חג, חול המועד, ראש השנה או יום כיפור קוראים קריאת המועד
  // ולא פרשת שבוע, ולכן הן אינן תופסות מקום במחזור.
  function hasFestivalReading(rd) {
    const h = rdToHeb(rd);
    if (h.m === 7 && (h.d <= 2 || h.d === 10 || (h.d >= 15 && h.d <= 22))) return true;
    if (h.m === 1 && h.d >= 15 && h.d <= 21) return true;
    if (h.m === 3 && h.d === 6) return true;
    return false;
  }

  const cycleCache = new Map();
  // מחזור הקריאה שנפתח בשמחת תורה של שנה עברית hy: רשימת השבתות הקוראות
  // פרשה, ולעומתן רשימת שמות הפרשות באותו אורך.
  function readingCycle(hy) {
    let cyc = cycleCache.get(hy);
    if (cyc !== undefined) return cyc;

    const combined = SEDRA_COMBINED[sedraYearKey(hy)];
    let names = null;
    if (combined) {
      names = [];
      for (let i = 0; i <= 52; i++) {
        if (combined.indexOf(i) !== -1) {
          names.push(PARSHIYOT[i] + PAIR_SEPARATOR + PARSHIYOT[i + 1]);
          i++;                                  // החלק השני של הצמד נקרא יחד
        } else {
          names.push(PARSHIYOT[i]);
        }
      }
    }

    const simchatTorah = hebToRd(hy, 7, 22);
    const nextSimchatTorah = hebToRd(hy + 1, 7, 22);
    const slots = [];
    for (let rd = shabbatAfter(simchatTorah); rd < nextSimchatTorah; rd += 7) {
      if (!hasFestivalReading(rd)) slots.push(rd);
    }

    // אם הספירה אינה מסתדרת, עדיף לא להציג פרשה מלהציג פרשה שגויה.
    cyc = (names && names.length === slots.length) ? { slots: slots, names: names } : null;
    if (cycleCache.size > 400) cycleCache.clear();
    cycleCache.set(hy, cyc);
    return cyc;
  }

  function parshaOfRd(rd) {
    if (dowOfRd(rd) !== 6) return null;
    const h = rdToHeb(rd);
    // שבתות תשרי שלפני שמחת תורה שייכות עדיין למחזור של השנה הקודמת.
    const hy = (h.m === 7 && h.d <= 22) ? h.y - 1 : h.y;
    const cyc = readingCycle(hy);
    if (!cyc) return null;
    const i = cyc.slots.indexOf(rd);
    return i === -1 ? null : cyc.names[i];
  }

  /* ============================================================
     4. מועדים, צומות וראשי חודשים — לוח ישראל
     ============================================================ */

  const T_YOMTOV = "yomtov", T_CHM = "cholhamoed", T_EREV = "erev", T_FAST = "fast",
    T_MINOR = "minor", T_MODERN = "modern", T_RC = "roshchodesh",
    T_SHABBAT = "specialShabbat", T_CHANUKAH = "chanukah";

  const CHANUKAH_CANDLES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שביעי", "שמיני"];

  // בתא של לוח יש מקום לשם אחד. rank קובע מי מנצח כששני מועדים חלים באותו יום,
  // והמספר הקטן חשוב יותר. אפשר לעקוף אותו למועד מסוים (ראה תענית בכורות).
  const TYPE_RANK = {};
  TYPE_RANK[T_YOMTOV] = 0; TYPE_RANK[T_CHM] = 1; TYPE_RANK[T_FAST] = 2; TYPE_RANK[T_EREV] = 3;
  TYPE_RANK[T_CHANUKAH] = 5; TYPE_RANK[T_MINOR] = 6; TYPE_RANK[T_MODERN] = 7;
  TYPE_RANK[T_SHABBAT] = 8; TYPE_RANK[T_RC] = 9;

  // הכלל: מועד נדחה או מוקדם רק לפי יום בשבוע, ותמיד באותה מידה בכל שנה.
  function shabbatBefore(rd) { return rd - (dowOfRd(rd) + 1); }      // השבת שלפני היום, לא כולל אותו
  function shabbatOnOrBefore(rd) { return rd - ((dowOfRd(rd) + 1) % 7); }
  function shabbatAfter(rd) { const gap = 6 - dowOfRd(rd); return rd + (gap === 0 ? 7 : gap); }

  const yearEventsCache = new Map();

  function eventsOfHebrewYear(hy) {
    let map = yearEventsCache.get(hy);
    if (map !== undefined) return map;
    map = new Map();

    const add = function (rd, key, name, type, opts) {
      const list = map.get(rd) || [];
      const ev = { key: key, name: name, type: type, short: (opts && opts.short) || name };
      // ימים רצופים של אותו מועד חולקים group, כדי להציג אותם כשורה אחת עם טווח.
      ev.group = (opts && opts.group) || key;
      ev.groupName = (opts && opts.groupName) || name;
      ev.rank = (opts && opts.rank != null) ? opts.rank : TYPE_RANK[type];
      if (opts && opts.fast) ev.fast = true;
      list.push(ev);
      map.set(rd, list);
    };
    const H = function (m, d) { return hebToRd(hy, m, d); };
    const leap = hebLeap(hy);
    const adar = leap ? 13 : 12;        // "אדר" של פורים הוא אדר ב׳ בשנה מעוברת

    /* ---- תשרי ---- */
    add(H(7, 1) - 1, "erev_rosh_hashana", "ערב ראש השנה", T_EREV, { short: "ערב ר״ה" });
    add(H(7, 1), "rosh_hashana_1", "ראש השנה", T_YOMTOV, { short: "ראש השנה" });
    add(H(7, 2), "rosh_hashana_2", "ראש השנה ב׳", T_YOMTOV, { short: "ראש השנה ב׳" });
    const gedaliah = H(7, 3);
    add(dowOfRd(gedaliah) === 6 ? gedaliah + 1 : gedaliah, "tzom_gedaliah", "צום גדליה", T_FAST);
    // שבת שובה היא השבת שבין ראש השנה ליום כיפור.
    add(shabbatOnOrBefore(H(7, 9)), "shabbat_shuva", "שבת שובה", T_SHABBAT);
    add(H(7, 9), "erev_yom_kippur", "ערב יום כיפור", T_EREV, { short: "ערב יו״כ" });
    add(H(7, 10), "yom_kippur", "יום כיפור", T_YOMTOV, { short: "יום כיפור", fast: true });
    add(H(7, 14), "erev_sukkot", "ערב סוכות", T_EREV);
    add(H(7, 15), "sukkot_1", "סוכות", T_YOMTOV, { short: "סוכות" });
    for (let d = 16; d <= 20; d++) {
      add(H(7, d), "sukkot_chm_" + (d - 14), "חול המועד סוכות", T_CHM, { short: "חוה״מ סוכות", group: "chm_sukkot" });
    }
    add(H(7, 21), "hoshana_raba", "הושענא רבה", T_CHM);
    add(H(7, 22), "shmini_atzeret", "שמיני עצרת ושמחת תורה", T_YOMTOV, { short: "שמחת תורה" });

    /* ---- חשוון: ימי הזיכרון הממלכתיים נוהגים רק משנת קביעתם ---- */
    if (hy >= 5758) {
      const rabin = H(8, 12);
      add(dowOfRd(rabin) === 5 ? rabin - 1 : rabin, "rabin", "יום הזיכרון ליצחק רבין", T_MODERN, { short: "זיכרון לרבין" });
    }
    if (hy >= 5769) {
      const sigd = H(8, 29);
      add(dowOfRd(sigd) === 6 ? sigd - 2 : sigd, "sigd", "חג הסיגד", T_MODERN);
    }

    /* ---- חנוכה: נר ראשון בערב כ״ד בכסלו ---- */
    const chanukahStart = H(9, 24);
    for (let i = 0; i < 8; i++) {
      add(chanukahStart + i, "chanukah_" + (i + 1), "חנוכה — נר " + CHANUKAH_CANDLES[i],
        T_CHANUKAH, { short: "נר " + CHANUKAH_CANDLES[i], group: "chanukah", groupName: "חנוכה" });
    }
    add(chanukahStart + 8, "chanukah_day_8", "חנוכה — יום שמיני", T_CHANUKAH,
      { short: "חנוכה", group: "chanukah", groupName: "חנוכה" });

    /* ---- טבת ושבט ---- */
    add(H(10, 10), "asara_btevet", "עשרה בטבת", T_FAST);
    add(H(11, 15), "tu_bishvat", "ט״ו בשבט", T_MINOR);
    if (hy >= 5750) add(H(11, 30), "yom_hamishpacha", "יום המשפחה", T_MODERN);

    /* ---- אדר ---- */
    if (leap) {
      add(H(12, 14), "purim_katan", "פורים קטן", T_MINOR);
      add(H(12, 15), "shushan_purim_katan", "שושן פורים קטן", T_MINOR);
    }
    add(shabbatOnOrBefore(H(adar, 1)), "shabbat_shekalim", "שבת שקלים", T_SHABBAT);
    add(shabbatBefore(H(adar, 14)), "shabbat_zachor", "שבת זכור", T_SHABBAT);
    const esther = H(adar, 13);
    add(dowOfRd(esther) === 6 ? esther - 2 : esther, "taanit_esther", "תענית אסתר", T_FAST);
    add(H(adar, 13), "erev_purim", "ערב פורים", T_MINOR);
    add(H(adar, 14), "purim", "פורים", T_MINOR);
    add(H(adar, 15), "shushan_purim", "שושן פורים", T_MINOR);

    /* ---- ניסן ---- */
    const hachodesh = shabbatOnOrBefore(H(1, 1));
    add(hachodesh, "shabbat_hachodesh", "שבת החודש", T_SHABBAT);
    add(hachodesh - 7, "shabbat_parah", "שבת פרה", T_SHABBAT);
    add(shabbatBefore(H(1, 15)), "shabbat_hagadol", "שבת הגדול", T_SHABBAT);
    const bechorot = H(1, 14);
    add(dowOfRd(bechorot) === 6 ? bechorot - 2 : bechorot, "taanit_bechorot", "תענית בכורות", T_FAST, { rank: 4 });
    add(H(1, 14), "erev_pesach", "ערב פסח", T_EREV);
    add(H(1, 15), "pesach_1", "פסח", T_YOMTOV, { short: "פסח" });
    for (let d = 16; d <= 20; d++) {
      add(H(1, d), "pesach_chm_" + (d - 14), "חול המועד פסח", T_CHM, { short: "חוה״מ פסח", group: "chm_pesach" });
    }
    add(H(1, 21), "pesach_7", "שביעי של פסח", T_YOMTOV, { short: "שביעי של פסח" });
    if (hy >= 5711) {
      const shoah = H(1, 27);
      const shoahDow = dowOfRd(shoah);
      add(shoahDow === 5 ? shoah - 1 : shoahDow === 0 ? shoah + 1 : shoah,
        "yom_hashoah", "יום הזיכרון לשואה ולגבורה", T_MODERN, { short: "יום השואה" });
    }

    /* ---- אייר: יום הזיכרון ויום העצמאות נקבעים יחד ---- */
    if (hy >= 5708) {
      const atzmautNominal = H(2, 5);
      const atzmautDow = dowOfRd(atzmautNominal);
      let atzmaut = atzmautNominal;
      if (atzmautDow === 5) atzmaut = atzmautNominal - 1;          // נופל בשישי — מוקדם ליום חמישי
      else if (atzmautDow === 6) atzmaut = atzmautNominal - 2;     // נופל בשבת — מוקדם ליום חמישי
      else if (atzmautDow === 1 && hy >= 5764) atzmaut = atzmautNominal + 1;  // נדחה מיום שני לשלישי (תיקון תשס״ד)
      add(atzmaut - 1, "yom_hazikaron", "יום הזיכרון לחללי מערכות ישראל", T_MODERN, { short: "יום הזיכרון" });
      add(atzmaut, "yom_haatzmaut", "יום העצמאות", T_MODERN);
    }
    add(H(2, 14), "pesach_sheni", "פסח שני", T_MINOR);
    add(H(2, 18), "lag_baomer", "ל״ג בעומר", T_MINOR);
    if (hy >= 5727) add(H(2, 28), "yom_yerushalayim", "יום ירושלים", T_MODERN);

    /* ---- סיוון ---- */
    add(H(3, 5), "erev_shavuot", "ערב שבועות", T_EREV);
    add(H(3, 6), "shavuot", "שבועות", T_YOMTOV, { short: "שבועות" });

    /* ---- תמוז ואב ---- */
    const tammuz = H(4, 17);
    add(dowOfRd(tammuz) === 6 ? tammuz + 1 : tammuz, "tzom_tammuz", "צום י״ז בתמוז", T_FAST, { short: "י״ז בתמוז" });
    const tishaNominal = H(5, 9);
    const deferred = dowOfRd(tishaNominal) === 6;
    const tisha = deferred ? tishaNominal + 1 : tishaNominal;
    add(shabbatBefore(tisha), "shabbat_chazon", "שבת חזון", T_SHABBAT);
    add(tisha - 1, "erev_tisha_bav", "ערב תשעה באב", T_EREV, { short: "ערב ת״ב" });
    add(tisha, "tisha_bav", deferred ? "תשעה באב (נדחה)" : "תשעה באב", T_FAST, { short: "תשעה באב" });
    add(shabbatAfter(tisha), "shabbat_nachamu", "שבת נחמו", T_SHABBAT);
    add(H(5, 15), "tu_bav", "ט״ו באב", T_MINOR);

    /* ---- ראשי חודשים: א׳ בכל חודש, וגם ל׳ בחודש שלפניו אם הוא מלא ---- */
    const months = hebMonthsInYear(hy);
    for (let mm = 7; mm <= months + 6; mm++) {
      const m = mm > months ? mm - months : mm;       // תשרי…אדר ואז ניסן…אלול
      if (m === 7) continue;                          // א׳ בתשרי הוא ראש השנה
      const name = "ראש חודש " + hebMonthName(hy, m);
      add(hebToRd(hy, m, 1), "rosh_chodesh_" + m, name, T_RC, { short: "ר״ח " + hebMonthName(hy, m) });
      const prev = m === 1 ? (leap ? 13 : 12) : m - 1;
      if (hebMonthLength(hy, prev) === 30) {
        add(hebToRd(hy, prev, 30), "rosh_chodesh_" + m + "_a", name, T_RC, { short: "ר״ח " + hebMonthName(hy, m) });
      }
    }

    if (yearEventsCache.size > 60) yearEventsCache.clear();
    yearEventsCache.set(hy, map);
    return map;
  }

  // מועדי יום בודד נשמרים לפי השנה העברית שלהם, אבל ערב ראש השנה שייך לשנה
  // שלפניה, ולכן בודקים גם את השנה הבאה.
  function eventsOfRd(rd) {
    const h = rdToHeb(rd);
    let out = [];
    const a = eventsOfHebrewYear(h.y).get(rd);
    if (a) out = out.concat(a);
    if (h.m === 6 && h.d === 29) {
      const b = eventsOfHebrewYear(h.y + 1).get(rd);
      if (b) out = out.concat(b);
    }
    if (dowOfRd(rd) === 6 && parshaOfRd(rd) === PARSHIYOT[15]) {
      out = out.concat([{ key: "shabbat_shirah", name: "שבת שירה", type: T_SHABBAT,
        short: "שבת שירה", group: "shabbat_shirah", groupName: "שבת שירה", rank: TYPE_RANK[T_SHABBAT] }]);
    }
    return out;
  }

  /* ============================================================
     5. זמני היום — מיקום השמש לפי NOAA
     ============================================================ */

  const RAD = Math.PI / 180;
  const ZENITH_SUN = 90.833;        // שקיעה/זריחה: מרכז השמש מתחת לאופק בשל שבירת האור

  function sunPosition(t) {
    const L0 = 280.46646 + t * (36000.76983 + t * 0.0003032);
    const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
    const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    const C = Math.sin(M * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t))
      + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * t)
      + Math.sin(3 * M * RAD) * 0.000289;
    const trueLong = L0 + C;
    const omega = 125.04 - 1934.136 * t;
    const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
    const meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
    const obliq = meanObliq + 0.00256 * Math.cos(omega * RAD);
    const decl = Math.asin(Math.sin(obliq * RAD) * Math.sin(appLong * RAD)) / RAD;
    const vy = Math.tan(obliq / 2 * RAD) * Math.tan(obliq / 2 * RAD);
    const eqTime = 4 * (vy * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD)
      + 4 * e * vy * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD)
      - 0.5 * vy * vy * Math.sin(4 * L0 * RAD)
      - 1.25 * e * e * Math.sin(2 * M * RAD)) / RAD;
    return { decl: decl, eqTime: eqTime };
  }

  // דקות מחצות UTC שבהן מרכז השמש נמצא בזווית הנתונה מהזנית.
  function solarMinutes(t, lat, lon, zenith, rising) {
    const sun = sunPosition(t);
    const cosH = (Math.cos(zenith * RAD) - Math.sin(lat * RAD) * Math.sin(sun.decl * RAD))
      / (Math.cos(lat * RAD) * Math.cos(sun.decl * RAD));
    if (cosH < -1 || cosH > 1) return null;          // באזורים קוטביים אין אירוע ביום הזה
    const ha = Math.acos(cosH) / RAD;
    return 720 - 4 * lon - sun.eqTime + (rising ? -4 * ha : 4 * ha);
  }

  // הזמן שבו מתרחש האירוע, כחותמת זמן אמיתית (UTC). מיקום השמש משתנה במשך
  // היום, ולכן מעדנים את החישוב סביב הזמן שנמצא — בלי זה יש סטייה של עד חצי דקה.
  function solarMs(rd, lat, lon, zenith, rising) {
    const jd0 = rd + 1721424.5;                      // JD בחצות UTC של היום הזה
    const century = function (dayFraction) { return (jd0 + dayFraction - 2451545) / 36525; };
    let minutes = solarMinutes(century(0.5 - lon / 360), lat, lon, zenith, rising);
    if (minutes == null) return null;
    for (let i = 0; i < 4; i++) {
      const next = solarMinutes(century(minutes / 1440), lat, lon, zenith, rising);
      if (next == null) return null;
      const settled = Math.abs(next - minutes) < 0.0005;   // פחות מ-0.03 שניות
      minutes = next;
      if (settled) break;
    }
    // נחתכים לשנייה שלמה, כמו בכל לוח מודפס — כך הדקה המוצגת אינה תלויה בשבריר שנייה.
    return (rd - RD_1970) * DAY_MS + Math.floor(minutes * 60) * 1000;
  }

  const floorMinute = function (ms) { return ms == null ? null : Math.floor(ms / MIN_MS) * MIN_MS; };
  const roundMinute = function (ms) { return ms == null ? null : Math.round(ms / MIN_MS) * MIN_MS; };

  /* ============================================================
     6. המקום ותצוגת שעה
     ============================================================ */

  const DEFAULT_PLACE = {
    name: "קריית גת",
    lat: 31.60998,
    lon: 34.76422,
    tz: "Asia/Jerusalem",
    candleMinutes: 20,
    havdalahDegrees: 8.5
  };

  function normalizePlace(place) {
    if (!place) return DEFAULT_PLACE;
    const lat = Number(place.lat), lon = Number(place.lon);
    const mins = Number(place.candleMinutes), deg = Number(place.havdalahDegrees);
    return {
      name: place.name || DEFAULT_PLACE.name,
      lat: Number.isFinite(lat) && Math.abs(lat) <= 90 ? lat : DEFAULT_PLACE.lat,
      lon: Number.isFinite(lon) && Math.abs(lon) <= 180 ? lon : DEFAULT_PLACE.lon,
      tz: place.tz || DEFAULT_PLACE.tz,
      candleMinutes: Number.isFinite(mins) && mins >= 0 && mins <= 120 ? Math.round(mins) : DEFAULT_PLACE.candleMinutes,
      havdalahDegrees: Number.isFinite(deg) && deg > 0 && deg <= 25 ? deg : DEFAULT_PLACE.havdalahDegrees
    };
  }

  const timeFmtCache = new Map();
  function timeFormatter(tz) {
    let f = timeFmtCache.get(tz);
    if (f === undefined) {
      try {
        f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
      } catch (e) {
        f = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
      }
      timeFmtCache.set(tz, f);
    }
    return f;
  }

  function hhmm(ms, place) {
    if (ms == null) return "";
    return timeFormatter(normalizePlace(place).tz).format(new Date(ms));
  }

  function fmtTime(ms, place) {
    if (ms == null) return "";
    // מבודדים את השעה מטקסט עברי סובב, כדי ש-18:23 לא יתהפך ל-23:18.
    return "⁦" + hhmm(ms, place) + "⁩";
  }

  function todayIso(place) {
    const p = normalizePlace(place);
    let f = timeFmtCache.get("date:" + p.tz);
    if (f === undefined) {
      try {
        f = new Intl.DateTimeFormat("en-CA", { timeZone: p.tz, year: "numeric", month: "2-digit", day: "2-digit" });
      } catch (e) {
        f = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
      }
      timeFmtCache.set("date:" + p.tz, f);
    }
    return f.format(new Date()).replace(/\//g, "-");
  }

  /* ============================================================
     7. תיאור יום שלם
     ============================================================ */

  function isYomTovRd(rd) {
    const list = eventsOfRd(rd);
    for (let i = 0; i < list.length; i++) if (list[i].type === T_YOMTOV) return true;
    return false;
  }
  function isRestRd(rd) { return dowOfRd(rd) === 6 || isYomTovRd(rd); }

  function zmanimOfRd(rd, p) {
    const sunriseMs = solarMs(rd, p.lat, p.lon, ZENITH_SUN, true);
    const sunsetMs = solarMs(rd, p.lat, p.lon, ZENITH_SUN, false);
    const tzeitMs = solarMs(rd, p.lat, p.lon, 90 + p.havdalahDegrees, false);

    const restToday = isRestRd(rd), restTomorrow = isRestRd(rd + 1);
    let candlesMs = null;
    if (restTomorrow && sunsetMs != null) {
      // חג שנכנס במוצאי שבת או במוצאי חג אינו נדלק לפני צאת הכוכבים.
      candlesMs = (restToday && isYomTovRd(rd + 1))
        ? roundMinute(tzeitMs)
        : floorMinute(sunsetMs - p.candleMinutes * MIN_MS);
    }
    const havdalahMs = (restToday && !restTomorrow) ? roundMinute(tzeitMs) : null;

    return {
      sunriseMs: sunriseMs, sunsetMs: sunsetMs, tzeitMs: tzeitMs,
      candlesMs: candlesMs, havdalahMs: havdalahMs
    };
  }

  // ספירת העומר נספרת מט״ז בניסן ועד ה׳ בסיוון, ולכן היא לעולם בניסן, אייר או סיוון.
  function omerOfRd(rd) {
    const h = rdToHeb(rd);
    if (h.m < 1 || h.m > 3) return null;
    const n = rd - hebToRd(h.y, 1, 15);
    return n >= 1 && n <= 49 ? n : null;
  }

  function dayOfRd(rd, place) {
    const p = normalizePlace(place);
    const events = eventsOfRd(rd);
    const dow = dowOfRd(rd);
    const isShabbat = dow === 6;

    let isYomTov = false, isCholHamoed = false, isFast = false, isErev = false;
    for (let i = 0; i < events.length; i++) {
      const t = events[i].type;
      if (t === T_YOMTOV) isYomTov = true;
      else if (t === T_CHM) isCholHamoed = true;
      else if (t === T_EREV) isErev = true;
      if (t === T_FAST || events[i].fast) isFast = true;   // יום כיפור הוא גם חג וגם צום
    }

    const zmanim = zmanimOfRd(rd, p);
    const kind = isYomTov ? T_YOMTOV : isCholHamoed ? T_CHM : isFast ? T_FAST
      : isErev ? T_EREV : isShabbat ? "shabbat" : "regular";

    return {
      iso: isoOfRd(rd),
      rd: rd,
      dow: dow,
      hebrew: hebrewFromRd(rd),
      events: events,
      parsha: parshaOfRd(rd),
      omer: omerOfRd(rd),
      kind: kind,
      isShabbat: isShabbat,
      isYomTov: isYomTov,
      isCholHamoed: isCholHamoed,
      isFast: isFast,
      isErev: isErev,
      isRest: isShabbat || isYomTov,
      zmanim: zmanim,
      restStart: zmanim.candlesMs,
      restEnd: zmanim.havdalahMs
    };
  }

  function day(iso, place) {
    const rd = rdOfIso(iso);
    return rd == null ? null : dayOfRd(rd, place);
  }

  const GREG_MONTHS_HE = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי",
    "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];

  function month(year, month1, place) {
    const y = Number(year), m = Number(month1);
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return null;
    const first = gregToRd(y, m, 1);
    const days = gregMonthLength(y, m);
    const start = first - dowOfRd(first);                 // תמיד מתחילים ביום ראשון
    const weeks = [];
    let week = [];
    for (let rd = start; week.length || rd < first + days; rd++) {
      const inMonth = rd >= first && rd < first + days;
      week.push(inMonth ? dayOfRd(rd, place) : null);
      if (week.length === 7) { weeks.push(week); week = []; }
    }

    const hFirst = hebrewFromRd(first), hLast = hebrewFromRd(first + days - 1);
    const hebrewSpan = hFirst.monthName === hLast.monthName && hFirst.yearLabel === hLast.yearLabel
      ? hFirst.monthName + " " + hFirst.yearLabel
      : hFirst.monthName + (hFirst.yearLabel === hLast.yearLabel ? "" : " " + hFirst.yearLabel)
        + "–" + hLast.monthName + " " + hLast.yearLabel;

    return {
      year: y, month: m,
      label: GREG_MONTHS_HE[m - 1] + " " + y,
      hebrewSpan: hebrewSpan,
      firstRd: first,
      days: days,
      weeks: weeks
    };
  }

  // הימים הבאים שיש בהם מועד או שבת, לתצוגת "מה קרוב".
  function upcoming(fromIso, daysAhead, place) {
    const start = rdOfIso(fromIso);
    if (start == null) return [];
    const span = Math.max(1, Math.min(800, Number(daysAhead) || 60));
    const out = [];
    for (let rd = start; rd < start + span; rd++) {
      const d = dayOfRd(rd, place);
      if (d.events.length || d.isShabbat) out.push(d);
    }
    return out;
  }

  return {
    DEFAULT_PLACE: DEFAULT_PLACE,
    TYPES: {
      YOMTOV: T_YOMTOV, CHOL_HAMOED: T_CHM, EREV: T_EREV, FAST: T_FAST, MINOR: T_MINOR,
      MODERN: T_MODERN, ROSH_CHODESH: T_RC, SPECIAL_SHABBAT: T_SHABBAT, CHANUKAH: T_CHANUKAH
    },
    PARSHIYOT: PARSHIYOT,
    PAIR_SEPARATOR: PAIR_SEPARATOR,
    hebrew: function (iso) { const rd = rdOfIso(iso); return rd == null ? null : hebrewFromRd(rd); },
    day: day,
    dayOfRd: dayOfRd,
    month: month,
    upcoming: upcoming,
    hhmm: hhmm,
    fmtTime: fmtTime,
    todayIso: todayIso,
    gematria: gematria,
    isoOfRd: isoOfRd,
    rdOfIso: rdOfIso,
    dowOfRd: dowOfRd,
    normalizePlace: normalizePlace
  };
});
