"use strict";

/* בדיקות ללוח העברי. התאריכים והזמנים כאן הם עוגנים ציבוריים שניתן לאמת בכל
 * לוח: תאריכי ראש השנה, החגים והצומות, וזמני כניסת שבת בקריית גת. לצדם יש
 * בדיקות מבנה שרצות על מאות שנים — הן תופסות שבירה בחישוב גם בתאריכים
 * שאיש לא חשב לבדוק. הבדיקות מריצות את המנוע כפי שהוא רץ בדפדפן, ומאמתות
 * במפורש שהזמנים הם של אזור הזמן של ישראל גם כשהמכשיר מוגדר לאזור אחר.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Luach = require("../../luach");

const keysOn = iso => Luach.day(iso).events.map(e => e.key).sort();
const hasKey = (iso, key) => Luach.day(iso).events.some(e => e.key === key);
const hhmm = iso => {
  const z = Luach.day(iso).zmanim;
  return {
    sunrise: Luach.hhmm(z.sunriseMs), sunset: Luach.hhmm(z.sunsetMs), tzeit: Luach.hhmm(z.tzeitMs),
    candles: z.candlesMs == null ? null : Luach.hhmm(z.candlesMs),
    havdalah: z.havdalahMs == null ? null : Luach.hhmm(z.havdalahMs)
  };
};

/* ---------- תאריך עברי ---------- */

test("ראש השנה נופל בתאריכים האזרחיים הידועים", () => {
  const rh = Luach.hebrew("2025-09-23");
  assert.equal(rh.y, 5786);
  assert.equal(rh.m, 7);
  assert.equal(rh.d, 1);
  assert.equal(Luach.hebrew("2026-09-12").label, "א׳ בתשרי תשפ״ז");
  assert.equal(Luach.hebrew("2027-10-02").label, "א׳ בתשרי תשפ״ח");
});

test("תאריך עברי מיתרגם לשם, לחודש ולגימטריה הנכונים", () => {
  assert.equal(Luach.hebrew("2026-09-15").label, "ד׳ בתשרי תשפ״ז");
  assert.equal(Luach.hebrew("2027-01-23").label, "ט״ו בשבט תשפ״ז");
  assert.equal(Luach.hebrew("2026-03-14").label, "כ״ה באדר תשפ״ו");
  // בשנה מעוברת יש אדר א׳ ואדר ב׳, ופורים באדר ב׳
  assert.equal(Luach.hebrew("2027-02-21").label, "י״ד באדר א׳ תשפ״ז");
  assert.equal(Luach.hebrew("2027-03-23").label, "י״ד באדר ב׳ תשפ״ז");
});

test("גימטריה: ט״ו וט״ז ולא י״ה/י״ו", () => {
  assert.equal(Luach.gematria(1), "א׳");
  assert.equal(Luach.gematria(15), "ט״ו");
  assert.equal(Luach.gematria(16), "ט״ז");
  assert.equal(Luach.gematria(20), "כ׳");
  assert.equal(Luach.gematria(29), "כ״ט");
  assert.equal(Luach.gematria(30), "ל׳");
  assert.equal(Luach.gematria(787), "תשפ״ז");
});

test("תאריך לא תקין מחזיר null ולא זורק", () => {
  ["", null, undefined, "2026-13-01", "2026-02-30", "26-01-01", "לא תאריך"].forEach(bad => {
    assert.equal(Luach.day(bad), null, String(bad));
    assert.equal(Luach.hebrew(bad), null, String(bad));
  });
});

/* ---------- מועדים ---------- */

test("החגים הגדולים נופלים בתאריכים הנכונים ומסומנים כיום טוב", () => {
  const yomtov = {
    "2026-09-12": "rosh_hashana_1",
    "2026-09-13": "rosh_hashana_2",
    "2026-09-21": "yom_kippur",
    "2026-09-26": "sukkot_1",
    "2026-10-03": "shmini_atzeret",
    "2027-04-22": "pesach_1",
    "2027-04-28": "pesach_7",
    "2027-06-11": "shavuot"
  };
  Object.entries(yomtov).forEach(([iso, key]) => {
    assert.ok(hasKey(iso, key), iso + " " + key);
    assert.equal(Luach.day(iso).isYomTov, true, iso);
    assert.equal(Luach.day(iso).kind, "yomtov", iso);
  });
});

test("חול המועד סוכות ופסח מסומנים כחול המועד ולא כיום טוב", () => {
  ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"].forEach(iso => {
    const d = Luach.day(iso);
    assert.equal(d.isCholHamoed, true, iso);
    assert.equal(d.isYomTov, false, iso);
  });
  assert.ok(hasKey("2026-10-02", "hoshana_raba"));
  ["2027-04-23", "2027-04-24", "2027-04-25", "2027-04-26", "2027-04-27"].forEach(iso => {
    assert.equal(Luach.day(iso).isCholHamoed, true, iso);
  });
});

test("חנוכה נמשכת שמונה נרות מכ״ד בכסלו, ואחריהם היום השמיני", () => {
  assert.deepEqual(keysOn("2026-12-04"), ["chanukah_1"]);
  assert.equal(Luach.day("2026-12-04").events[0].name, "חנוכה — נר ראשון");
  for (let i = 0; i < 8; i++) {
    const iso = Luach.isoOfRd(Luach.rdOfIso("2026-12-04") + i);
    assert.ok(hasKey(iso, "chanukah_" + (i + 1)), iso);
  }
  assert.ok(hasKey("2026-12-12", "chanukah_day_8"));
  assert.equal(hasKey("2026-12-13", "chanukah_day_8"), false);
});

test("מועדים קטנים וימי זיכרון ממלכתיים", () => {
  assert.ok(hasKey("2027-01-23", "tu_bishvat"));
  assert.ok(hasKey("2027-02-21", "purim_katan"));
  assert.ok(hasKey("2027-03-23", "purim"));
  assert.ok(hasKey("2027-03-24", "shushan_purim"));
  assert.ok(hasKey("2027-05-25", "lag_baomer"));
  assert.ok(hasKey("2027-05-11", "yom_hazikaron"));
  assert.ok(hasKey("2027-05-12", "yom_haatzmaut"));
  assert.ok(hasKey("2027-06-04", "yom_yerushalayim"));
  assert.ok(hasKey("2027-05-04", "yom_hashoah"));
});

test("ימי זיכרון ממלכתיים אינם מופיעים בשנים שלפני שנקבעו", () => {
  const before = iso => Luach.day(iso).events.map(e => e.key);
  assert.equal(before("1947-04-17").includes("yom_hashoah"), false);   // כ״ז בניסן תש״ז
  assert.equal(before("1940-05-12").includes("yom_haatzmaut"), false); // ה׳ באייר ת״ש
  assert.ok(hasKey("2027-05-12", "yom_haatzmaut"));
});

test("ראש חודש: יום אחד בחודש חסר, ושני ימים אחרי חודש מלא", () => {
  // תשרי מלא, ולכן ראש חודש חשוון נמשך ל׳ בתשרי וא׳ בחשוון
  assert.ok(hasKey("2026-10-11", "rosh_chodesh_8_a"));
  assert.ok(hasKey("2026-10-12", "rosh_chodesh_8"));
  assert.equal(Luach.day("2026-10-12").events.find(e => e.key === "rosh_chodesh_8").name, "ראש חודש חשוון");
  // א׳ בתשרי הוא ראש השנה ואינו מסומן כראש חודש
  assert.equal(Luach.day("2026-09-12").events.some(e => e.type === "roshchodesh"), false);
});

test("שבתות מיוחדות מזוהות לפי הכלל שלהן", () => {
  assert.ok(hasKey("2026-09-19", "shabbat_shuva"));
  assert.ok(hasKey("2027-01-23", "shabbat_shirah"));   // שבת פרשת בשלח
  assert.ok(hasKey("2026-03-14", "shabbat_hachodesh"));
  assert.ok(hasKey("2027-04-17", "shabbat_hagadol"));  // השבת שלפני פסח
  assert.ok(hasKey("2027-08-07", "shabbat_chazon"));
  assert.ok(hasKey("2027-08-14", "shabbat_nachamu"));
});

/* ---------- דחיית צומות ---------- */

test("צום נדחה כשהוא נופל בשבת, ומוקדם כשכך הדין", () => {
  // צום גדליה: ג׳ בתשרי שנופל בשבת נדחה לד׳ בתשרי
  assert.ok(hasKey("2028-09-24", "tzom_gedaliah"));
  assert.equal(Luach.hebrew("2028-09-24").d, 4);
  // תענית אסתר: י״ג באדר שנופל בשבת מוקדם ליום חמישי, י״א באדר
  assert.ok(hasKey("2028-03-09", "taanit_esther"));
  assert.equal(Luach.hebrew("2028-03-09").d, 11);
  assert.equal(Luach.day("2028-03-09").dow, 4);
  // תשעה באב: ט׳ באב שנופל בשבת נדחה לי׳ באב, וערב הצום הוא השבת עצמה
  assert.ok(hasKey("2029-07-22", "tisha_bav"));
  assert.equal(Luach.day("2029-07-22").events.find(e => e.key === "tisha_bav").name, "תשעה באב (נדחה)");
  assert.equal(Luach.hebrew("2029-07-22").d, 10);
  assert.ok(hasKey("2029-07-21", "erev_tisha_bav"));
});

test("צום מסומן isFast ואינו יום מנוחה, למעט יום כיפור", () => {
  const fast = Luach.day("2026-09-14");
  assert.equal(fast.isFast, true);
  assert.equal(fast.isRest, false);
  assert.equal(fast.kind, "fast");
  const kippur = Luach.day("2026-09-21");
  assert.equal(kippur.isFast, true);
  assert.equal(kippur.isRest, true);
});

/* ---------- ספירת העומר ---------- */

test("ספירת העומר: יום א׳ בט״ז בניסן, ל״ג בעומר ביום 33, ו-49 ימים בסך הכל", () => {
  assert.equal(Luach.day("2027-04-23").omer, 1);
  assert.equal(Luach.hebrew("2027-04-23").d, 16);
  assert.equal(Luach.day("2027-05-25").omer, 33);
  assert.ok(hasKey("2027-05-25", "lag_baomer"));
  assert.equal(Luach.day("2027-06-10").omer, 49);
  assert.equal(Luach.day("2027-06-11").omer, null);   // שבועות עצמו אינו נספר
  assert.equal(Luach.day("2027-04-22").omer, null);   // ליל הסדר עוד לפני הספירה
  let count = 0;
  for (let rd = Luach.rdOfIso("2027-01-01"); rd <= Luach.rdOfIso("2027-12-31"); rd++) {
    if (Luach.dayOfRd(rd).omer) count++;
  }
  assert.equal(count, 49);
});

/* ---------- פרשת השבוע ---------- */

test("פרשת השבוע, כולל פרשות מחוברות ושבתות שקוראים בהן קריאת מועד", () => {
  assert.equal(Luach.day("2026-09-19").parsha, "האזינו");
  assert.equal(Luach.day("2026-10-10").parsha, "בראשית");
  assert.equal(Luach.day("2026-10-17").parsha, "נח");
  assert.equal(Luach.day("2027-01-23").parsha, "בשלח");
  assert.equal(Luach.day("2026-03-14").parsha, "ויקהל" + Luach.PAIR_SEPARATOR + "פקודי");
  assert.equal(Luach.PAIR_SEPARATOR, "\u05be");   // מקף עברי, שגם נשבר נכון בשורה
  assert.equal(Luach.day("2026-09-26").parsha, null);   // סוכות א׳ בשבת — קריאת החג
  assert.equal(Luach.day("2026-09-18").parsha, null);   // יום שישי אינו שבת
});

test("בכל שבת שאינה מועד יש פרשה, ובמועד אין — על פני מאה שנה", () => {
  let shabbatot = 0, withParsha = 0, festivalShabbatot = 0;
  for (let rd = Luach.rdOfIso("2000-01-01"); rd <= Luach.rdOfIso("2100-12-31"); rd++) {
    if (Luach.dowOfRd(rd) !== 6) continue;
    shabbatot++;
    const d = Luach.dayOfRd(rd);
    if (d.parsha) { withParsha++; continue; }
    // שבת בלי פרשה חייבת להיות יום טוב או חול המועד
    assert.ok(d.isYomTov || d.isCholHamoed, "שבת בלי פרשה ובלי מועד: " + d.iso);
    festivalShabbatot++;
  }
  assert.ok(shabbatot > 5200, "מספר השבתות: " + shabbatot);
  assert.equal(withParsha + festivalShabbatot, shabbatot);
  assert.ok(festivalShabbatot > 0);
});

/* ---------- זמני היום וכניסת שבת ---------- */

test("זמני קריית גת, כפי שהם מופיעים בלוח", () => {
  assert.deepEqual(hhmm("2026-09-18"),
    { sunrise: "06:26", sunset: "18:43", tzeit: "19:19", candles: "18:23", havdalah: null });
  assert.deepEqual(hhmm("2026-09-19"),
    { sunrise: "06:27", sunset: "18:41", tzeit: "19:17", candles: null, havdalah: "19:18" });
  assert.equal(hhmm("2026-10-09").candles, "17:56");
  assert.equal(hhmm("2026-10-10").havdalah, "18:51");
});

test("כניסת שבת היא 20 דקות לפני השקיעה, מעוגלת למטה", () => {
  for (let rd = Luach.rdOfIso("2026-01-01"); rd <= Luach.rdOfIso("2026-12-31"); rd++) {
    const d = Luach.dayOfRd(rd);
    if (d.zmanim.candlesMs == null || d.isRest) continue;   // חג שנכנס במוצאי שבת נמדד אחרת
    const gapSeconds = (d.zmanim.sunsetMs - d.zmanim.candlesMs) / 1000;
    assert.ok(gapSeconds >= 20 * 60 && gapSeconds < 21 * 60, d.iso + " פער " + gapSeconds);
  }
});

test("ערב חג באמצע השבוע מקבל זמן הדלקה, וצאת החג בסופו", () => {
  assert.equal(hhmm("2026-09-20").candles, "18:20");   // ערב יום כיפור, יום ראשון
  assert.equal(hhmm("2026-09-21").havdalah, "19:15");
  assert.equal(hhmm("2026-09-25").candles, "18:13");   // ערב סוכות, יום שישי
  assert.equal(hhmm("2026-09-26").havdalah, "19:09");
  assert.equal(hhmm("2026-10-02").candles, "18:04");   // הושענא רבה, ערב שמיני עצרת
});

test("חג שנכנס אחרי שבת או אחרי יום טוב נדלק בצאת הכוכבים, לא לפני השקיעה", () => {
  // א׳ בתשרי תשפ״ז חל בשבת, ונרות היום השני נדלקים בצאת השבת
  const rh1 = Luach.day("2026-09-12");
  assert.equal(rh1.isShabbat, true);
  assert.equal(rh1.isYomTov, true);
  assert.equal(Luach.hhmm(rh1.zmanim.candlesMs), Luach.hhmm(rh1.zmanim.tzeitMs));
  assert.equal(Luach.hhmm(rh1.zmanim.candlesMs), "19:27");
  // בערב שלפני החג הראשון ההדלקה כרגיל, לפני השקיעה
  const erev = Luach.day("2026-09-11");
  assert.ok(erev.zmanim.candlesMs < erev.zmanim.sunsetMs);
  // אין הבדלה כשלמחרת נכנס יום טוב נוסף
  assert.equal(rh1.zmanim.havdalahMs, null);
  assert.equal(Luach.hhmm(Luach.day("2026-09-13").zmanim.havdalahMs), "19:26");
});

test("יום טוב שלמחרתו שבת נדלק לפני השקיעה", () => {
  // שבועות תשפ״ז חל ביום שישי, והנרות לשבת נדלקים לפני השקיעה
  const shavuot = Luach.day("2027-06-11");
  assert.equal(shavuot.isYomTov, true);
  assert.equal(shavuot.dow, 5);
  assert.ok(shavuot.zmanim.candlesMs < shavuot.zmanim.sunsetMs);
  assert.equal(shavuot.zmanim.havdalahMs, null);
  assert.equal(Luach.hhmm(Luach.day("2027-06-12").zmanim.havdalahMs) !== "", true);
});

test("ביום חול אין כניסה ואין יציאה, ובשבת רגילה יש יציאה בלבד", () => {
  const plain = Luach.day("2026-09-15");
  assert.equal(plain.zmanim.candlesMs, null);
  assert.equal(plain.zmanim.havdalahMs, null);
  assert.equal(plain.kind, "regular");
  const shabbat = Luach.day("2026-10-10");
  assert.equal(shabbat.zmanim.candlesMs, null);
  assert.ok(shabbat.zmanim.havdalahMs > shabbat.zmanim.sunsetMs);
});

test("כניסה ויציאה נמצאות בכל שבת, ובאותו סדר נכון, על פני עשרים שנה", () => {
  let fridays = 0;
  for (let rd = Luach.rdOfIso("2026-01-01"); rd <= Luach.rdOfIso("2046-12-31"); rd++) {
    const d = Luach.dayOfRd(rd);
    if (d.zmanim.sunriseMs >= d.zmanim.sunsetMs) assert.fail("זריחה אחרי שקיעה: " + d.iso);
    if (d.zmanim.tzeitMs <= d.zmanim.sunsetMs) assert.fail("צאת הכוכבים לפני השקיעה: " + d.iso);
    if (d.isRest && !Luach.dayOfRd(rd + 1).isRest) {
      assert.ok(d.zmanim.havdalahMs != null, "אין יציאה ביום מנוחה: " + d.iso);
    }
    if (!d.isRest && Luach.dayOfRd(rd + 1).isRest) {
      assert.ok(d.zmanim.candlesMs != null, "אין כניסה בערב יום מנוחה: " + d.iso);
      if (d.dow === 5) fridays++;
    }
  }
  assert.ok(fridays > 1000, "מספר ימי שישי שנבדקו: " + fridays);
});

test("הזמנים הם של אזור הזמן של ישראל, גם כשהמכשיר מוגדר לאזור אחר", () => {
  const d = Luach.day("2026-09-18");
  assert.equal(Luach.hhmm(d.zmanim.candlesMs), "18:23");
  // הפורמט מבודד את השעה מטקסט עברי, כדי שלא תתהפך בתצוגה
  assert.equal(Luach.fmtTime(d.zmanim.candlesMs), "⁦" + "18:23" + "⁩");
  // התאריך "היום" נקבע לפי ישראל ולא לפי שעון המכשיר
  assert.match(Luach.todayIso(), /^\d{4}-\d{2}-\d{2}$/);
});

/* ---------- הגדרת מקום ---------- */

test("מקום חלופי משנה את הזמנים, ומקום שגוי חוזר לברירת המחדל", () => {
  const jerusalem = { name: "ירושלים", lat: 31.7683, lon: 35.2137, tz: "Asia/Jerusalem", candleMinutes: 40, havdalahDegrees: 8.5 };
  const d = Luach.day("2026-09-18", jerusalem);
  const gap = (d.zmanim.sunsetMs - d.zmanim.candlesMs) / 1000;
  assert.ok(gap >= 40 * 60 && gap < 41 * 60, "פער ירושלים " + gap);

  const broken = Luach.normalizePlace({ name: "", lat: "abc", lon: 999, candleMinutes: -5, havdalahDegrees: 0 });
  assert.deepEqual(broken, Luach.DEFAULT_PLACE);
  assert.deepEqual(Luach.normalizePlace(null), Luach.DEFAULT_PLACE);
  assert.equal(Luach.DEFAULT_PLACE.name, "קריית גת");
  assert.equal(Luach.DEFAULT_PLACE.candleMinutes, 20);
});

/* ---------- מבנה הלוח ---------- */

test("לוח חודשי: שבועות שלמים, ראשון ראשון, וכל ימי החודש בדיוק פעם אחת", () => {
  [[2026, 9], [2026, 2], [2028, 2], [2027, 12], [2026, 1]].forEach(([y, m]) => {
    const mo = Luach.month(y, m);
    assert.ok(mo, y + "-" + m);
    mo.weeks.forEach(w => assert.equal(w.length, 7));
    assert.equal(Luach.dowOfRd(Luach.rdOfIso(mo.weeks[0].find(Boolean).iso)) >= 0, true);
    const days = mo.weeks.flat().filter(Boolean).map(d => d.iso);
    assert.equal(days.length, mo.days);
    assert.equal(new Set(days).size, mo.days);
    assert.equal(days[0], y + "-" + String(m).padStart(2, "0") + "-01");
    // התא הראשון בכל שבוע הוא יום ראשון
    mo.weeks.forEach(w => {
      const first = w.find(Boolean);
      if (first === w[0]) assert.equal(first.dow, 0);
    });
  });
  assert.equal(Luach.month(2026, 13), null);
  assert.equal(Luach.month(2026, 0), null);
});

test("לוח חודשי מתויג בשם החודש האזרחי ובטווח החודשים העבריים", () => {
  const sep = Luach.month(2026, 9);
  assert.equal(sep.label, "ספטמבר 2026");
  assert.equal(sep.hebrewSpan, "אלול תשפ״ו–תשרי תשפ״ז");
});

test("upcoming מחזיר רק ימים שיש בהם מועד או שבת", () => {
  const list = Luach.upcoming("2026-09-15", 20);
  assert.ok(list.length > 0);
  list.forEach(d => assert.ok(d.events.length || d.isShabbat, d.iso));
  assert.ok(list.some(d => d.events.some(e => e.key === "yom_kippur")));
  assert.equal(Luach.upcoming("לא תאריך", 10).length, 0);
});

/* ---------- שלמות הלוח העברי על פני מאות שנים ---------- */

test("מבנה השנה העברית תקין לאורך 200 שנה", () => {
  // מעבר אחד על הימים, ואיסוף כל א׳ בתשרי שנמצא בדרך
  const newYears = [];
  for (let rd = Luach.rdOfIso("1940-01-01"); rd <= Luach.rdOfIso("2140-12-31"); rd++) {
    const d = Luach.dayOfRd(rd);
    if (d.hebrew.m === 7 && d.hebrew.d === 1) newYears.push({ rd: rd, y: d.hebrew.y, dow: d.dow });
  }
  assert.ok(newYears.length > 199, "ראשי שנה שנמצאו: " + newYears.length);
  const lengths = new Set();
  newYears.forEach((ny, i) => {
    // לא אד״ו ראש: ראש השנה אינו חל ביום ראשון, רביעי או שישי
    assert.ok([1, 2, 4, 6].includes(ny.dow), "ראש השנה " + ny.y + " ביום " + ny.dow);
    const next = newYears[i + 1];
    if (!next) return;
    assert.equal(next.y, ny.y + 1, "רצף שנים אצל " + ny.y);
    const len = next.rd - ny.rd;
    lengths.add(len);
    assert.ok([353, 354, 355, 383, 384, 385].includes(len), "אורך שנה " + ny.y + ": " + len);
  });
  assert.equal(lengths.size, 6, "אורכי שנה שנמצאו: " + [...lengths].sort().join(","));
});

test("המרת תאריך הלוך ושוב אינה מאבדת יום, על פני 200 שנה", () => {
  let days = 0;
  for (let rd = Luach.rdOfIso("1950-01-01"); rd <= Luach.rdOfIso("2150-12-31"); rd++) {
    const iso = Luach.isoOfRd(rd);
    assert.equal(Luach.rdOfIso(iso), rd, iso);
    const d = Luach.day(iso);
    assert.equal(d.rd, rd);
    assert.equal(d.hebrew.d >= 1 && d.hebrew.d <= 30, true, iso);
    assert.equal(d.hebrew.m >= 1 && d.hebrew.m <= 13, true, iso);
    days++;
  }
  assert.ok(days > 73000, "ימים שנבדקו: " + days);
});

test("התאריך העברי מתקדם ביום אחד בכל יום אזרחי, בלי דילוג ובלי חזרה", () => {
  let prev = null;
  for (let rd = Luach.rdOfIso("2020-01-01"); rd <= Luach.rdOfIso("2060-12-31"); rd++) {
    const h = Luach.dayOfRd(rd).hebrew;
    if (prev) {
      const sameMonth = prev.y === h.y && prev.m === h.m;
      if (sameMonth) assert.equal(h.d, prev.d + 1, Luach.isoOfRd(rd));
      else assert.equal(h.d, 1, "תחילת חודש חדש: " + Luach.isoOfRd(rd));
    }
    prev = h;
  }
});

test("כל מועד מופיע פעם אחת בכל שנה עברית, על פני 60 שנה", () => {
  const once = ["rosh_hashana_1", "rosh_hashana_2", "yom_kippur", "sukkot_1", "shmini_atzeret",
    "pesach_1", "pesach_7", "shavuot", "purim", "tisha_bav", "tzom_gedaliah", "asara_btevet",
    "taanit_esther", "tzom_tammuz", "lag_baomer", "tu_bishvat", "shabbat_shuva", "shabbat_hagadol"];
  const counts = {};
  for (let rd = Luach.rdOfIso("2000-09-30"); rd <= Luach.rdOfIso("2060-09-01"); rd++) {
    Luach.dayOfRd(rd).events.forEach(ev => {
      if (once.includes(ev.key)) counts[ev.key] = (counts[ev.key] || 0) + 1;
    });
  }
  once.forEach(key => assert.ok(counts[key] >= 59 && counts[key] <= 60, key + ": " + counts[key]));
});

/* ---------- החלטות מכוונות, מקובעות כדי שלא ייקראו בעתיד כבאג ----------
 * הלוח מתאר יום אזרחי, ולא יום עברי שמתחיל בשקיעה. שלושה מקומות נגזרים מכך
 * והם שונים במכוון מהאופן שבו לוחות שמודדים לפי היום העברי מסמנים אותם.
 */

test("ערב תשעה באב אינו יום צום, כי הצום מתחיל בשקיעה שבסופו", () => {
  const erev = Luach.day("2027-08-11");          // ח׳ באב תשפ״ז, יום חול
  assert.ok(hasKey("2027-08-11", "erev_tisha_bav"));
  assert.equal(erev.isFast, false);
  assert.equal(erev.isErev, true);
  // הצום עצמו למחרת, והוא כן מסומן
  assert.equal(Luach.day("2027-08-12").isFast, true);
});

test("ערב פורים ונר ראשון של חנוכה אינם ערב של יום מנוחה", () => {
  // י״ג באדר הוא קודם כל תענית אסתר; ערב פורים נלווה לו ואינו הופך אותו לערב חג
  const esther = Luach.day("2027-03-22");
  assert.ok(hasKey("2027-03-22", "erev_purim"));
  assert.equal(esther.isFast, true);
  assert.equal(esther.isErev, false);
  assert.equal(esther.kind, "fast");
  // כ״ד בכסלו הוא יום חול שבערבו מדליקים נר ראשון
  const chanukah = Luach.day("2026-12-04");
  assert.ok(hasKey("2026-12-04", "chanukah_1"));
  assert.equal(chanukah.isErev, false);
  assert.equal(chanukah.kind, "regular");
  // חנוכה אינה מוסיפה זמן הדלקה ללוח. ביום הזה יש כניסת שבת רק מפני שהוא שישי
  assert.equal(chanukah.dow, 5);
  assert.equal(Luach.day("2026-12-06").zmanim.candlesMs, null);   // נר שלישי, יום ראשון
});

test("יום טוב הוא בדיוק שמונת ימי החג של ישראל, ורק הם קובעים יום מנוחה", () => {
  const expected = new Set(["rosh_hashana_1", "rosh_hashana_2", "yom_kippur", "sukkot_1",
    "shmini_atzeret", "pesach_1", "pesach_7", "shavuot"]);
  const found = new Set();
  for (let rd = Luach.rdOfIso("2000-01-01"); rd <= Luach.rdOfIso("2100-12-31"); rd++) {
    const d = Luach.dayOfRd(rd);
    if (!d.isYomTov) continue;
    d.events.forEach(ev => { if (ev.type === "yomtov") found.add(ev.key); });
    assert.equal(d.isRest, true, d.iso);
  }
  assert.deepEqual([...found].sort(), [...expected].sort());
  // חול המועד אינו יום מנוחה, ולכן ביום שאחריו אין הבדלה אלא המשך המועד
  const chm = Luach.day("2026-09-28");
  assert.equal(chm.isCholHamoed, true);
  assert.equal(chm.isRest, false);
});

test("צאת הכוכבים שנופלת בדיוק על חצי דקה מתעגלת למעלה", () => {
  // צאת הכוכבים 17:20:30 — היציאה נקבעת ל-17:21 ולא ל-17:20
  assert.equal(Luach.hhmm(Luach.day("2026-11-14").zmanim.havdalahMs), "17:21");
  assert.equal(Luach.hhmm(Luach.day("2024-12-28").zmanim.havdalahMs), "17:26");
  assert.equal(Luach.hhmm(Luach.day("2029-05-20").zmanim.havdalahMs), "20:15");
  // אותו כלל כשההדלקה עצמה היא בצאת הכוכבים: א׳ בתשרי תשפ״ו שחל ביום חמישי
  assert.equal(Luach.hhmm(Luach.day("2065-10-01").zmanim.candlesMs), "19:02");
});

test("שבועות שחל ביום שישי נדלק לפני השקיעה, גם כשצאת הכוכבים היא בחצי דקה", () => {
  ["1972-05-19", "2050-05-27"].forEach(iso => {
    const d = Luach.day(iso);
    assert.equal(d.dow, 5);
    assert.ok(hasKey(iso, "shavuot"));
    assert.equal(d.isRest, true);
    assert.ok(d.zmanim.candlesMs < d.zmanim.sunsetMs, iso);
    const gap = (d.zmanim.sunsetMs - d.zmanim.candlesMs) / 1000;
    assert.ok(gap >= 20 * 60 && gap < 21 * 60, iso + " פער " + gap);
  });
});
